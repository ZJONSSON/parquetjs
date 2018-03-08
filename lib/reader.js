'use strict';
const fs = require('fs');
const thrift = require('thrift');
const parquet_thrift = require('../gen-nodejs/parquet_types')
const parquet_shredder = require('./shred')
const parquet_util = require('./util')
const parquet_schema = require('./schema')
const parquet_codec = require('./codec')
const parquet_compression = require('./compression')
const BufferReader = require('./bufferReader');
const streamz = require('streamz');
const PathReader = require('./pathReader');

/**
 * Parquet File Magic String
 */
const PARQUET_MAGIC = 'PAR1';

/**
 * Parquet File Format Version
 */
const PARQUET_VERSION = 1;

/**
 * Internal type used for repetition/definition levels
 */
const PARQUET_RDLVL_TYPE = 'INT32';
const PARQUET_RDLVL_ENCODING = 'RLE';

/**
 * A parquet cursor is used to retrieve rows from a parquet file in order
 */
class ParquetCursor  {

  /**
   * Create a new parquet reader from the file metadata and an envelope reader.
   * It is usually not recommended to call this constructor directly except for
   * advanced and internal use cases. Consider using getCursor() on the
   * ParquetReader instead
   */
  constructor(metadata, envelopeReader, schema, columnList) {
    this.metadata = metadata;
    this.envelopeReader = envelopeReader;
    this.schema = schema;
    this.columnList = columnList;
    this.rowGroup = [];
    this.rowGroupIndex = 0;
  }

  /**
   * Retrieve the next row from the cursor. Returns a row or NULL if the end
   * of the file was reached
   */
  async next() {
    if (this.rowGroup.length === 0) {
      if (this.rowGroupIndex >= this.metadata.row_groups.length) {
        return null;
      }

      let rowBuffer = await this.envelopeReader.readRowGroup(
          this.schema,
          this.metadata.row_groups[this.rowGroupIndex],
          this.columnList);

      this.rowGroup = parquet_shredder.materializeRecords(this.schema, rowBuffer);
      this.rowGroupIndex++;
    }

    return this.rowGroup.shift();
  }

  /**
   * Rewind the cursor the the beginning of the file
   */
  rewind() {
    this.rowGroup = [];
    this.rowGroupIndex = 0;
  }

};

/**
 * A parquet reader allows retrieving the rows from a parquet file in order.
 * The basic usage is to create a reader and then retrieve a cursor/iterator
 * which allows you to consume row after row until all rows have been read. It is
 * important that you call close() after you are finished reading the file to
 * avoid leaking file descriptors.
 */
class ParquetReader {

  /**
   * Open the parquet file pointed to by the specified path and return a new
   * parquet reader
   */
  static async openFile(filePath, options) {
    let envelopeReader = await ParquetEnvelopeReader.openFile(filePath, options);
    return this.openEnvelopeReader(envelopeReader);
  }

  static async openBuffer(buffer, options) {
    let envelopeReader = await ParquetEnvelopeReader.openBuffer(buffer, options);
    return this.openEnvelopeReader(envelopeReader);
  }

  /**
   * Open the parquet file from S3 using the supplied aws client and params
   * The params have to include `Bucket` and `Key` to the file requested
   * This function returns a new parquet reader
   */
  static async openS3(client, params, options) {
    let envelopeReader = await ParquetEnvelopeReader.openS3(client, params, options);
    return this.openEnvelopeReader(envelopeReader);
  }

  /**
   * Open the parquet file from a url using the supplied request module
   * params should either be a string (url) or an object that includes 
   * a `url` property.  
   * This function returns a new parquet reader
   */
  static async openUrl(request, params, options) {
    let envelopeReader = await ParquetEnvelopeReader.openUrl(request, params, options);
    return this.openEnvelopeReader(envelopeReader); 
  }

  static async openEnvelopeReader(envelopeReader) {
    try {
      let header = envelopeReader.readHeader();
      let metadataPromise = envelopeReader.readFooter();
      await header;
      let metadata = await metadataPromise;
      return new ParquetReader(metadata, envelopeReader);
    } catch (err) {
      await envelopeReader.close();
      throw err;
    }
  }

  /**
   * Create a new parquet reader from the file metadata and an envelope reader.
   * It is not recommended to call this constructor directly except for advanced
   * and internal use cases. Consider using one of the open{File,Buffer} methods
   * instead
   */
  constructor(metadata, envelopeReader) {
    if (metadata.version != PARQUET_VERSION) {
      throw 'invalid parquet version';
    }

    this.metadata = envelopeReader.metadata = metadata;
    this.envelopeReader = envelopeReader;
    this.schema = envelopeReader.schema = new parquet_schema.ParquetSchema(
        decodeSchema(
            this.metadata.schema.splice(1)));
  }

  /**
   * Return a cursor to the file. You may open more than one cursor and use
   * them concurrently. All cursors become invalid once close() is called on
   * the reader object.
   *
   * The required_columns parameter controls which columns are actually read
   * from disk. An empty array or no value implies all columns. A list of column
   * names means that only those columns should be loaded from disk.
   */
  getCursor(columnList) {
    if (!columnList) {
      columnList = [];
    }

    columnList = columnList.map((x) => x.constructor === Array ? x : [x]);

    return new ParquetCursor(
        this.metadata, 
        this.envelopeReader,
        this.schema,
        columnList);
  }

  /**
   * Return the number of rows in this file. Note that the number of rows is
   * not neccessarily equal to the number of rows in each column.
   */
  getRowCount() {
    return this.metadata.num_rows;
  }

  /**
   * Returns the ParquetSchema for this file
   */
  getSchema() {
    return this.schema;
  }

  /**
   * Returns the user (key/value) metadata for this file
   */
  getMetadata() {
    let md = {};
    for (let kv of this.metadata.key_value_metadata) {
      md[kv.key] = kv.value;
    }

    return md;
  }

  /**
   * Close this parquet reader. You MUST call this method once you're finished
   * reading rows
   */
  async close() {
    await this.envelopeReader.close();
    this.envelopeReader = null;
    this.metadata = null;
  }

}

/**
 * The parquet envelope reader allows direct, unbuffered access to the individual
 * sections of the parquet file, namely the header, footer and the row groups.
 * This class is intended for advanced/internal users; if you just want to retrieve
 * rows from a parquet file use the ParquetReader instead
 */
let ParquetEnvelopeReaderIdCounter = 0;
class ParquetEnvelopeReader {

  static async openFile(filePath, options) {
    let fileStat = await parquet_util.fstat(filePath);
    let fileDescriptor = await parquet_util.fopen(filePath);

    let readFn = parquet_util.fread.bind(undefined, fileDescriptor);
    let closeFn = parquet_util.fclose.bind(undefined, fileDescriptor);

    return new ParquetEnvelopeReader(readFn, closeFn, fileStat.size, options);
  }

  static async openBuffer(buffer, options) {
    let readFn = (offset, length) => buffer.slice(offset,offset+length);
    let closeFn = () => ({});
    return new ParquetEnvelopeReader(readFn, closeFn, buffer.length, options);
  }

  static async openS3(client, params, options) {
    let fileStat = async () => client.headObject(params).promise().then(d => d.ContentLength);

    let readFn = async (offset, length) => {
      let Range = `bytes=${offset}-${offset+length-1}`;
      let res = await client.getObject(Object.assign({Range}, params)).promise();
      return res.Body;
    };

    let closeFn = () => ({});

    return new ParquetEnvelopeReader(readFn, closeFn, fileStat, options);
  }

  static async openUrl(request, params, options) {
     if (typeof params === 'string')
      params = {url: params};
    if (!params.url)
      throw new Error('URL missing');

    params.encoding = params.encoding || null;

    let defaultHeaders = params.headers || {};

    let filesize = async () => new Promise( (resolve, reject) => {
      let req = request(params);
      req.on('response', res => {
        req.abort();
        resolve(res.headers['content-length']);
      });
      req.on('error', reject);
    });

    let readFn = (offset, length) => {
      let range = `bytes=${offset}-${offset+length-1}`;
      let headers = Object.assign({}, defaultHeaders, {range});
      let req = Object.assign({}, params, {headers});
      return new Promise( (resolve, reject) => {
        request(req, (err, res) => {
          if (err) {
            reject(err);
          } else {
            resolve(res.body);
          }
        });
      });
    };

    let closeFn = () => ({});

    return new ParquetEnvelopeReader(readFn, closeFn, filesize, options);
  }

  constructor(readFn, closeFn, fileSize, options) {
    options = options || {};
    this.readFn = readFn;
    this.id = ++ParquetEnvelopeReaderIdCounter;
    this.close = closeFn;
    this.fileSize = fileSize;
    if (options.maxLength || options.maxSpan || options.queueWait) {
      const bufferReader = new BufferReader(this, options);
      this.read = (offset, length) => bufferReader.read(offset, length);
    }
  }

  read(offset, length) {
    return this.readFn(offset, length);
  }

  readHeader() {
    return this.read(0, PARQUET_MAGIC.length).then(buf => {
      if (buf.toString() != PARQUET_MAGIC) {
        throw 'not valid parquet file'
      }
    });
  }

  search(paths, options) {
    let sourceIncluded;
    options = options || {};
    let concurrency = options.concurrency || 500;
    //let columnNumbers = paths.map(p => this.metadata.row_groups[0].columns.findIndex(d => d.meta_data.path_in_schema.join(',') === p.path));
    let reader = this;  // we have to explicitly define reader as the streams redefine `this` context 
    let pathReader = new PathReader(reader, paths);
    
    let rowGroups = reader.metadata.row_groups.filter( (rowGroup, i) => {
      rowGroup.no = i;
      return pathReader.matchesRowGroupStats(rowGroup);
    });

    // Stream all rowgroups that have data inside the min/max
    function streamRowGroups() {
      let out = streamz(); 
      rowGroups.forEach(rowGroup => out.write(rowGroup));
      out.end();
      return out;
    }

    // Pushes all pages that have data inside the min/max from a rowgroup
    function pages(rowGroup) {
      return Promise.all([pathReader.loadOffsetInfo(rowGroup), pathReader.findRelevantPages(rowGroup)])
        .then(r => {
          let offsets = r[0];
          let pages = r[1];
          pages.forEach(pageIndex => {
            this.push({offsets, pageNo: pageIndex, rowGroupNo: rowGroup.no});
          });
        });
    }

    function results(page) {
      return pathReader.getRecords(page.offsets, page.pageNo, page.rowGroupNo)
        .then(records => {
          records.forEach(rec => {
            this.push(rec)
          });
        });
    }

    let res = {
      rowGroups,
      pages: () => streamRowGroups().pipe(streamz(concurrency,pages)),
      results: () => res.pages().pipe(streamz(concurrency,results)),
      first: async () => new Promise( (resolve, reject) => {
        const results = res.results();
        results
          .on('error',reject)
          .pipe(streamz(d => {
            resolve(d);
            results.destroy();
          }))
          .on('finish',() => {
            reject('not_found');
          });
        }),
      sort: (field) => {
        let columnNumber = paths.findIndex(d => d.path === field);
        let pages;
        let out = streamz();
        let buffer = [];

        async function init() {
          pages = await res.pages().promise();

          pages.forEach(page => {
            page.max_value = page.cols[columnNumber].max_values[page.pageNo];
            page.min_value = page.cols[columnNumber].min_values[page.pageNo];
          });
        }

        async function next() {
          // 1 Find the lowest maximum_value of all remaining pages
          // 2 Get data from all pages with minimum_value < lowest maximum_value
          // 3 Add data to buffer and push all values < lowest maximum_value
          // 4 Values > lowest maximum_value go into buffer
          // Repeat until we have read all the pages
          let lowestMax = pages.reduce( (p,d) => Math.min(p,d.max_value),Infinity);
          let candidates = [];
          pages = pages.reduce( (p,page) => {
            if (page.min_value <= lowestMax) {
              candidates.push(page);
            } else {
              p.push(page);
            }
            return p;
          },[]);

          const candidateResults = streamz(concurrency,results);
          candidates.forEach(candidate => candidateResults.write(candidate));
          candidateResults.end();

          const candidateData = await candidateResults.promise();
          candidateData.forEach(d => buffer.push(d));

          buffer.sort( (a,b) => a[field]-b[field]);

          buffer = buffer.reduce( (p,d) => {
            if (d[field] <= lowestMax) {
              out.push(d);
            } else {
              p.push(d);
            }
            return p;
          },[]);

          if (pages.length) {
            return next();
          } else {
            out.end();
          }
        }

        init().then(next).catch(e => out.emit('error',e));

        return out;
      }
    };

    return res;
  }

  // Helper function to get the column object for a particular path and row_group
  getColumn(path, row_group) {
    let column;
    if (!isNaN(row_group)) {
      row_group = this.metadata.row_groups[row_group];
    }

    if (typeof path === 'string') {
      if (!row_group) {
       throw `Missing RowGroup ${row_group}`;
      }
      column = row_group.columns.find(d => d.meta_data.path_in_schema.join(',') === path);
      if (!column) {
        throw `Column ${path} Not Found`;
      }
    } else {
      column = path;
    }
    return column;
  }

  readOffsetIndex(path, row_group) {
    let column = this.getColumn(path, row_group);
    return this.read(+column.offset_index_offset, column.offset_index_length).then(data => {
      let offset_index = new parquet_thrift.OffsetIndex();
      parquet_util.decodeThrift(offset_index, data);
      offset_index.column = column;
      //Object.defineProperty(offset_index,'column', {value: column, enumerable: false});
      return offset_index;
    });
  }

  readColumnIndex(path, row_group) {
    let column = this.getColumn(path, row_group);
    return this.read(+column.column_index_offset, column.column_index_length).then(data => {
      let column_index = new parquet_thrift.ColumnIndex();
      parquet_util.decodeThrift(column_index, data);
      column_index.column = column;
      return column_index;
    });
  }

  readPage(offsetIndex, pageNumber, records) {
    // TODO: faster than assign?
    let column = Object.assign({},offsetIndex.column);
    column.metadata = Object.assign({},column.metadata);
    column.meta_data.data_page_offset = offsetIndex.page_locations[pageNumber].offset;
    column.meta_data.total_compressed_size =  offsetIndex.page_locations[pageNumber].compressed_page_size;
    return this.readColumnChunk(this.schema, column).then(chunk => {
      chunk.column = column;
      //Object.defineProperty(chunk,'column', {value: column});
      let data = {
        columnData: {[chunk.column.meta_data.path_in_schema.join(',')]: chunk},
        rowCount: offsetIndex.page_locations.length
      };

      return parquet_shredder.materializeRecords(this.schema, data, records);
    });
  }

  // Read the complete index (column and offset) for all pages in a column
  async readIndex(path) {
    const columnNum = this.metadata.row_groups[0].columns.find(d => d.meta_data.path_in_schema.join(',') === path);
    if (columnNum === -1) {
      throw `Column ${path} Not Found`;
    }
    // We begin by finding the range of the Indices
    const range = {
      first: Infinity,
      last: 0
    };

    this.metadata.row_groups.forEach(row => {
      const column = row.columns[columnNum];
      range.first = Math.min(range.first,column.column_index_offset, column.offset_index_offset);
      range.last = Math.max(range.last, column.column_index_offset+column.column_index_length, column.offset_index_offset + column.offset_index_length);
    });

    const buffer = await this.read(range.first, range.last - range.first);

    let columnIndices = [];
    let offsetIndices = [];

    this.metadata.row_groups.forEach( (row,i) => {
      let column = row.columns[columnNum];
      let readCol = buffer.slice(+column.column_index_offset - range.first,column.column_index_offset + column.column_index_length - range.first);
      let column_index = new parquet_thrift.ColumnIndex();
      parquet_util.decodeThrift(column_index,readCol);
      column_index.row_group = i;
      columnIndices.push(column_index);

      let readOff = buffer.slice(+column.offset_index_offset - range.first, +column.offset_index_offset +column.offset_index_length - range.first);
      let offset_index = new parquet_thrift.OffsetIndex();
      parquet_util.decodeThrift(offset_index,readOff);
      offset_index.row_group = i;
      offsetIndices.push(offset_index);
    });

    return offsetIndices.reduce( (p,d,i) => {
      d.page_locations.forEach( (l,ii) => {
        l.max_value = columnIndices[i].max_values[ii];
        l.min_value = columnIndices[i].min_values[ii];
        l.row_group_no = d.row_group;
        l.page_no = ii;
        p.push(l);
      });
      return p;
    },[]);
  }

  async readRowGroup(schema, rowGroup, columnList) {
    var buffer = {
      rowCount: +rowGroup.num_rows,
      columnData: {}
    };

    let requests = [];

    for (let colChunk of rowGroup.columns) {
      const colMetadata = colChunk.meta_data;
      const colKey = colMetadata.path_in_schema;

      if (columnList.length > 0 && parquet_util.fieldIndexOf(columnList, colKey) < 0) {
        continue;
      }

      requests.push(this.readColumnChunk(schema, colChunk).then(payload => ({
        colKey, payload
      })));
    }

    let data = await Promise.all(requests);

    data.forEach(d => {
      buffer.columnData[d.colKey] = d.payload;
    });

    return buffer;
  }

  readColumnChunk(schema, colChunk) {
    if (colChunk.file_path !== null) {
      return Promise.reject('external references are not supported');
    }

    let field = schema.findField(colChunk.meta_data.path_in_schema);
    let type = parquet_util.getThriftEnum(
        parquet_thrift.Type,
        colChunk.meta_data.type);

    let compression = parquet_util.getThriftEnum(
        parquet_thrift.CompressionCodec,
        colChunk.meta_data.codec);

    let pagesOffset = +colChunk.meta_data.data_page_offset;
    let pagesSize = +colChunk.meta_data.total_compressed_size;
    return this.read(pagesOffset, pagesSize).then(pagesBuf => decodeDataPages(pagesBuf, {
      type: type,
      rLevelMax: field.rLevelMax,
      dLevelMax: field.dLevelMax,
      compression: compression,
      column: field
    }));
  }

  async readFooter() {
    if (typeof this.fileSize === 'function') {
      this.fileSize = await this.fileSize();
    }
    let trailerLen = PARQUET_MAGIC.length + 4;
    let trailerBuf = await this.read(this.fileSize - trailerLen, trailerLen);

    if (trailerBuf.slice(4).toString() != PARQUET_MAGIC) {
      throw 'not a valid parquet file';
    }

    let metadataSize = trailerBuf.readUInt32LE(0);
    let metadataOffset = this.fileSize - metadataSize - trailerLen;
    if (metadataOffset < PARQUET_MAGIC.length) {
      throw 'invalid metadata size';
    }

    let metadataBuf = await this.read(metadataOffset, metadataSize);
    let metadata = new parquet_thrift.FileMetaData();
    parquet_util.decodeThrift(metadata, metadataBuf);
    return metadata;
  }

}

/**
 * Decode a consecutive array of data using one of the parquet encodings
 */
function decodeValues(type, encoding, cursor, count, opts) {
  if (!(encoding in parquet_codec)) {
    throw 'invalid encoding: ' + encoding;
  }

  return parquet_codec[encoding].decodeValues(type, cursor, count, opts);
}

function decodeDataPages(buffer, opts) {
  let cursor = {
    buffer: buffer,
    offset: 0,
    size: buffer.length
  };

  let data = {
    rlevels: [],
    dlevels: [],
    values: [],
    count: 0
  };

  while (cursor.offset < cursor.size) {
    const pageHeader = new parquet_thrift.PageHeader();
    cursor.offset += parquet_util.decodeThrift(pageHeader, cursor.buffer.slice(cursor.offset));

    const pageType = parquet_util.getThriftEnum(
        parquet_thrift.PageType,
        pageHeader.type);

    let pageData = null;
    switch (pageType) {
      case 'DATA_PAGE':
        pageData = decodeDataPage(cursor, pageHeader, opts);
        break;
      case 'DATA_PAGE_V2':
        pageData = decodeDataPageV2(cursor, pageHeader, opts);
        break;
      default:
        throw "invalid page type: " + pageType;
    }

    for (let i = 0; i < pageData.rlevels.length; i++) {
      data.rlevels.push(pageData.rlevels[i]);
      data.dlevels.push(pageData.dlevels[i]);
      if (pageData.values[i] !== undefined) {
        data.values.push(pageData.values[i]);
      }
    }
    data.count += pageData.count;
  }


  return data;
}

function decodeDataPage(cursor, header, opts) {
  let valueCount = header.data_page_header.num_values;
  let valueEncoding = parquet_util.getThriftEnum(
      parquet_thrift.Encoding,
      header.data_page_header.encoding);

  /* read repetition levels */
  let rLevelEncoding = parquet_util.getThriftEnum(
      parquet_thrift.Encoding,
      header.data_page_header.repetition_level_encoding);

  let rLevels = new Array(valueCount);
  if (opts.rLevelMax > 0) {
    rLevels = decodeValues(
        PARQUET_RDLVL_TYPE,
        rLevelEncoding,
        cursor,
        valueCount,
        { bitWidth: parquet_util.getBitWidth(opts.rLevelMax) });
  } else {
    rLevels.fill(0);
  }

  /* read definition levels */
  let dLevelEncoding = parquet_util.getThriftEnum(
      parquet_thrift.Encoding,
      header.data_page_header.definition_level_encoding);

  let dLevels = new Array(valueCount);
  if (opts.dLevelMax > 0) {
    dLevels = decodeValues(
        PARQUET_RDLVL_TYPE,
        dLevelEncoding,
        cursor,
        valueCount,
        { bitWidth: parquet_util.getBitWidth(opts.dLevelMax) });
  } else {
    dLevels.fill(0);
  }

  /* read values */
  let valueCountNonNull = 0;
  for (let dlvl of dLevels) {
    if (dlvl === opts.dLevelMax) {
      ++valueCountNonNull;
    }
  }

  let values = decodeValues(
      opts.type,
      valueEncoding,
      cursor,
      valueCountNonNull,
      {
        typeLength: opts.column.typeLength,
        bitWidth: opts.column.typeLength
      });

  return {
    dlevels: dLevels,
    rlevels: rLevels,
    values: values,
    count: valueCount
  };
}

function decodeDataPageV2(cursor, header, opts) {
  const cursorEnd = cursor.offset + header.compressed_page_size;

  const valueCount = header.data_page_header_v2.num_values;
  const valueCountNonNull = valueCount - header.data_page_header_v2.num_nulls;
  const valueEncoding = parquet_util.getThriftEnum(
      parquet_thrift.Encoding,
      header.data_page_header_v2.encoding);

  /* read repetition levels */
  let rLevels = new Array(valueCount);
  if (opts.rLevelMax > 0) {
    rLevels = decodeValues(
        PARQUET_RDLVL_TYPE,
        PARQUET_RDLVL_ENCODING,
        cursor,
        valueCount,
        {
          bitWidth: parquet_util.getBitWidth(opts.rLevelMax),
          disableEnvelope: true
        });
  } else {
    rLevels.fill(0);
  }

  /* read definition levels */
  let dLevels = new Array(valueCount);
  if (opts.dLevelMax > 0) {
    dLevels = decodeValues(
        PARQUET_RDLVL_TYPE,
        PARQUET_RDLVL_ENCODING,
        cursor,
        valueCount,
        {
          bitWidth: parquet_util.getBitWidth(opts.dLevelMax),
          disableEnvelope: true
        });
  } else {
    dLevels.fill(0);
  }

  /* read values */
  let valuesBufCursor = cursor;

  if (header.data_page_header_v2.is_compressed) {
    let valuesBuf = parquet_compression.inflate(
        opts.compression,
        cursor.buffer.slice(cursor.offset, cursorEnd));

    valuesBufCursor = {
      buffer: valuesBuf,
      offset: 0,
      size: valuesBuf.length
    };

    cursor.offset = cursorEnd;
  }

  let values = decodeValues(
      opts.type,
      valueEncoding,
      valuesBufCursor,
      valueCountNonNull,
      {
        typeLength: opts.column.typeLength,
        bitWidth: opts.column.typeLength
      });

  return {
    dlevels: dLevels,
    rlevels: rLevels,
    values: values,
    count: valueCount
  };
}

function decodeSchema(schemaElements) {
  let schema = {};
  schemaElements.forEach(schemaElement => {

    let repetitionType = parquet_util.getThriftEnum(
        parquet_thrift.FieldRepetitionType,
        schemaElement.repetition_type);

    let optional = false;
    let repeated = false;
    switch (repetitionType) {
      case 'REQUIRED':
        break;
      case 'OPTIONAL':
        optional = true;
        break;
      case 'REPEATED':
        repeated = true;
        break;
    };

    if (schemaElement.num_children > 0) {
      schema[schemaElement.name] = {
        optional: optional,
        repeated: repeated,
        fields: Object.create({},{
          /* define parent and num_children as non-enumerable */
          parent: {
            value: schema,
            enumerable: false 
          },
          num_children: {
            value: schemaElement.num_children,
            enumerable: false
          }
        })
      };
      /* move the schema pointer to the children */
      schema = schema[schemaElement.name].fields;
    } else {
      let logicalType = parquet_util.getThriftEnum(
          parquet_thrift.Type,
          schemaElement.type);

      if (schemaElement.converted_type != null) {
        logicalType = parquet_util.getThriftEnum(
            parquet_thrift.ConvertedType,
            schemaElement.converted_type);
      }

      schema[schemaElement.name] = {
        type: logicalType,
        typeLength: schemaElement.type_length,
        optional: optional,
        repeated: repeated
      };
    }

    /* if we have processed all children we move schema pointer to parent again */
    while (schema.parent && Object.keys(schema).length === schema.num_children) {
      schema = schema.parent;
    }
  });
  return schema;
}

module.exports = {
  ParquetEnvelopeReader,
  ParquetReader,
};

