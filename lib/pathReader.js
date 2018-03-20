'use strict';
const QuickLRU = require('quick-lru');
const lru = new QuickLRU({maxSize: (+process.env.PARQUET_CACHE_SIZE) || 30000});

function memoize(type, key, fn, timer, skipCache) {
  timer && timer('read', type, key);

  let result = !skipCache && lru.get(key);
  if (!result) {
    timer && timer('miss', type, key);
    let startTime = new Date().getTime();
    result = fn().then(d => {
      timer && timer('complete', type, key, `${new Date().getTime() - startTime}ms`);
      return d;
    });
    !skipCache && lru.set(key, result);
  }
  return result;
}

function parseItem(item) {
  if (item.and) {
    return new AndReader(item.and);
  }
  else if (item.or) {
    return new OrReader(item.or);
  }
  else if (item.min !== undefined || item.max !== undefined) {
    return new RangeReaderItem(item);
  }
  else if (item.value !== undefined) {
    return new ValueReaderItem(item);
  }
  else {
    return new PathReaderItem(item);
  }
}

class MultiReader {
  constructor(paths) {
    this.items = paths.map(parseItem);
  }
  
  prepareColumns(reader, timer) {
    this.reader = reader;
    this.timer = timer;
    this.items.forEach(item => item.prepareColumns(reader, timer));
  }

  firstColumnIndex() {
    return this.items[0].firstColumnIndex();
  }

  loadOffsetInfo(rowGroup, target) {
    if (!target) {
      target = {};
    }
    return Promise.all(this.items.map(item => item.loadOffsetInfo(rowGroup, target))).then(() => target);
  }

  memoize(type, key, fn) {
    return memoize(type, key, fn, this.timer);
  }

  getPageCount(rowGroup) {
    let columnIndex = this.firstColumnIndex(),
        reader = this.reader,
        path = rowGroup.columns[columnIndex].meta_data.path_in_schema.join(',');

    return this.memoize('offsetIndex', `${this.reader.id}_offsetIndex_rowgroup${rowGroup.no}_${path}`, () => this.reader.readOffsetIndex(rowGroup.columns[columnIndex]))
      .then(offsetIndex => offsetIndex.page_locations.length);
  }

  findRelevantPages(rowGroup) {
    return Promise.all([this.preloadRelevantPageInfo(rowGroup), this.getPageCount(rowGroup)])
      .then(r => { // move to spread if we use bluebird
        let cb = r[0];
        let pageCount = r[1];

        let results = [];
        for (var i = 0; i < pageCount; i++) {
          if (cb(i)) {
            results.push(i);
          }
        }
        return results;
      });
  }

  getRecords(offsetInfo, pageNo, rowGroupNo) {
    let records = [];

    records._columnsLoaded = new Set();
    return this.loadFilteredFields(offsetInfo, pageNo, records, rowGroupNo).then(records => {
      let filteredResults = null;

      // we might not have any filtered fields to load, and if that's the case then
      // don't worry about it.  but if there are filtered records, then we shoul see
      // if we should short circuit
      if (records.length > 0) {
        filteredResults = [];
        for (var i = 0; i < records.length; i++) {
          let record = records[i];

          if (this.filterRecord(record)) {
            filteredResults.push(record);
          }
          else {
            record._remove = true;
          }
        }
        if (filteredResults.length === 0) {
          return [];
        }
      }

      return this.loadRecords(offsetInfo, pageNo, records, rowGroupNo).then(() => filteredResults || records);
    });
  }

  loadRecords(offsetInfo, pageNo, records, rowGroupNo) {
    return Promise.all(this.items.map(item => item.loadRecords(offsetInfo, pageNo, records, rowGroupNo)))
      .then(() => records);
  }

  loadFilteredFields(offsetInfo, pageNo, records, rowGroupNo) {
    return Promise.all(this.items.map(item => item.loadFilteredFields(offsetInfo, pageNo, records, rowGroupNo)))
      .then(() => records);
  }
}

class AndReader extends MultiReader {
  matchesRowGroupStats(rowGroup) {
    for (var i = 0; i < this.items.length; i++) {
      if (!this.items[i].matchesRowGroupStats(rowGroup)) {
        return false;
      }
    }
    return true;
  }

  filterRecord(record) {
    for (var i = 0; i < this.items.length; i++) {
      if (!this.items[i].filterRecord(record)) {
        return false;
      }
    }
    return true;
  }

  preloadRelevantPageInfo(rowGroup) {
    return Promise.all(this.items.map(item => item.preloadRelevantPageInfo(rowGroup))).then(items => pageIndex => {
      for (var i = 0; i < items.length; i++) {
        if (!items[i](pageIndex)) {
          return false;
        }
      }
      return true;
    });
  }
}

class OrReader extends MultiReader {
  matchesRowGroupStats(rowGroup) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].matchesRowGroupStats(rowGroup)) {
        return true;
      }
    }
    return false;
  }

  filterRecord(record) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].filterRecord(record)) {
        return true;
      }
    }
    return false;
  }

  preloadRelevantPageInfo(rowGroup) {
    return Promise.all(this.items.map(item => item.preloadRelevantPageInfo(rowGroup))).then(items => pageIndex => {
      for (var i = 0; i < items.length; i++) {
        if (items[i](pageIndex)) {
          return true;
        }
      }
      return false;
    });
  }
}

class PathReaderItem {
  constructor(item) {
    this.path = item.path;
    this.index = item.index;
    this.source = item.source;
  }

  memoize(type, key, fn, skipCache) {
    return memoize(type, key, fn, this.timer, skipCache);
  }

  prepareColumns(reader, timer) {
    this.reader = reader;
    this.timer = timer;
    this.columnIndex = reader.metadata.row_groups[0].columns.findIndex(d => d.meta_data.path_in_schema.join(',') === this.path);
  }

  firstColumnIndex() {
    return this.columnIndex;
  }

  matchesRowGroupStats(rowGroup) {
    return true;
  }

  filterRecord(record) {
    return true;
  }

  loadOffsetInfo(rowGroup, target) {  
    if (this.index) {
      return;
    }
    let columnIndex = this.columnIndex;
    const column = rowGroup.columns[columnIndex];
    return this.memoize('offsetIndex', `${this.reader.id}_offsetIndex_rowgroup${rowGroup.no}_${this.path}`, () => this.reader.readOffsetIndex(column))
      .then(offsetIndex => {
        target[columnIndex] = offsetIndex;
        target.pageCount = offsetIndex.page_locations.length;
      });
  }

  preloadRelevantPageInfo(rowGroup) {
    return () => true;
  }

  _loadRecords(offsetInfo, pageNo, records, rowGroupNo) {
    let columnIndex = this.columnIndex,
        reader = this.reader,
        source = this.source,
        path = this.path;

    if (records._columnsLoaded.has(columnIndex)) {
      return;
    }
    records._columnsLoaded.add(columnIndex);

    let readPage = () => reader.readPage(offsetInfo[columnIndex], pageNo, []).then(r => {
      if (source) {
        let result = [];
        for (var i = 0; i < r.length; i++) {
          result.push(Object(r[i][path]));
        }
        return result;
      }
      else {
        let result = [];
        for (var i = 0; i < r.length; i++) {
          result.push(r[i][path]);
        }
        return result;
      }
    });

    return this.memoize('page_' + this.path, `${reader.id}_page_rowgroup${rowGroupNo}_${this.path}_page${pageNo}_${source ? 'source' : 'no_source'}`, readPage, source).then(columnRecords => {

        if (source) {
          if (records.length === 0) {
            for (var i = 0; i < columnRecords.length; i++) {
              let newRecord = {};

              let columnRecord = columnRecords[i];
              if (!columnRecord.json) {
                columnRecord.json = JSON.parse(columnRecord.toString());
              }
              let json = columnRecord.json;

              for (var key in json) {
                newRecord[key] = json[key];
              }
              records.push(newRecord);
            }
          }
          else {
            for (var i = 0; i < columnRecords.length; i++) {
              let record = records[i];
              if (!record._remove) {
                let columnRecord = columnRecords[i];
                if (!columnRecord.json) {
                  columnRecord.json = JSON.parse(columnRecord.toString());
                }
                let json = columnRecord.json;
                for (var key in json) {
                  record[key] = json[key];
                }
              }
            }
          }
        }
        else {
          if (records.length === 0) {
            for (var i = 0; i < columnRecords.length; i++) {
              records.push({[path]: columnRecords[i]});
            }
          }
          else {
            for (var i = 0; i < columnRecords.length; i++) {
              let record = records[i];
              if (!record._remove) {
                record[path] = columnRecords[i];
              }
            }
          }
        }
        return records;
      });
  }

  loadFilteredFields(offsetInfo, pageNo, records, rowGroupNo) {
    if (!this.filtered || this.index) {
      return records;
    }
    return this._loadRecords(offsetInfo, pageNo, records, rowGroupNo);
  }

  loadRecords(offsetInfo, pageNo, records, rowGroupNo) {
    if (this.index) {
      return records;
    }
    return this._loadRecords(offsetInfo, pageNo, records, rowGroupNo);
  }
}

class RangeReaderItem extends PathReaderItem {
  constructor(item) {
    super(item);
    this.sMin = item.min !== undefined ? String(item.min) : undefined;
    this.sMax = item.max !== undefined ? String(item.max) : undefined;
    this.min = item.min;
    this.max = item.max;
    this.filtered = true;
  }

  matchesRowGroupStats(rowGroup) {
    const column = rowGroup.columns[this.columnIndex];
    const stats = column.meta_data.statistics;

    return ((this.sMin === undefined || stats.max_value >= this.sMin) && 
            (this.sMax === undefined || stats.min_value <= this.sMax));
  }

  filterRecord(record) {
    if (this.index) {
      return true;
    }

    let value = record[this.path];
    if ((this.min !== undefined && value < this.min) ||
        (this.max !== undefined && value > this.max)) {
      return false;
    }
    return true;
  }

  preloadRelevantPageInfo(rowGroup) {
    let min = this.min,
        max = this.max,
        reader = this.reader,
        columnIndex = this.columnIndex;

    return this.memoize('columnIndex', `${reader.id}_columnIndex_rowgroup${rowGroup.no}_${this.path}`, () => reader.readColumnIndex(rowGroup.columns[columnIndex]))
      .then(colInfo => pageIndex => {
        if ((min !== undefined && min > colInfo.max_values[pageIndex]) ||
            (max !== undefined && max < colInfo.min_values[pageIndex])) {
          return false;
        }
        return true;
      });
  }
}

class ValueReaderItem extends PathReaderItem {
  constructor(item) {
    super(item);
    this.sValue = String(item.value);
    this.value = item.value;
    this.filtered = true;
  }

  filterRecord(record) {
    if (this.index) {
      return true;
    }

    return record[this.path] == this.value;
  }

  matchesRowGroupStats(rowGroup) {
    const column = rowGroup.columns[this.columnIndex];
    const stats = column.meta_data.statistics;

    return (stats.min_value <= this.sValue && stats.max_value >= this.sValue);
  }

  preloadRelevantPageInfo(rowGroup) {
    if (this.source) {
      return true;
    }

    let value = this.value,
        sValue = this.sValue,
        columnIndex = this.columnIndex,
        reader = this.reader;

    return this.memoize('columnIndex', `${reader.id}_columnIndex_rowgroup${rowGroup.no}_${this.path}`, () => reader.readColumnIndex(rowGroup.columns[columnIndex]))
      .then(colInfo => pageIndex => {
        if (colInfo.min_values[pageIndex] <= value && colInfo.max_values[pageIndex] >= value) {
          return true;
        }
        return false;
      });
  }
}

class PathReader extends AndReader  {
  constructor(reader, paths, timer) {
    super(paths);
    this.prepareColumns(reader, timer);
  }
}

module.exports = PathReader;