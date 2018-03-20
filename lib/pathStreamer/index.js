const etl = require('etl');
const streamz = require('streamz');
const RowRange = require('./rowRange');
const parseFilterPhase = require('./parseFilterPhase');
const CONCURRENCY = 500;

class PathStreamer {
  constructor(spec, readers, timer) {
    this.timer = timer;

    this.rootStream = streamz(); 
    readers.forEach(reader => reader.metadata.row_groups.forEach((rowGroup, index) => {
      rowGroup.no = index;
      this.rootStream.write(new RowRange(reader, rowGroup, timer));
    }));
    this.rootStream.end();

    this.stream = this.rootStream;
    if (spec.filter) {
      spec.filter.forEach(filterSpec => {
        this.stream = this.stream.pipe(parseFilterPhase(Array.isArray(filterSpec) ? filterSpec : [filterSpec]).pipe());
      });
    }

    if (spec.fields) {
      this.stream = this.stream.pipe(this.loadFields(spec.fields));
    }

    if (spec.post) {
      spec.post.forEach(post => {
        if (post.type === 'filter') {
          let script = post.script;
          this.stream = this.stream.pipe(etl.map(function(d) {
            if (script(d)) {
              this.push(d);
            }
          }));
        }
        else if (post.type === 'transform') {
          let script = post.script;
          this.stream = this.stream.pipe(etl.map(function(d) {
            this.push(script(d));
          }));
        }
      });
    }
  }

  loadFields(fields) {
    return etl.chain(stream => {
      return stream.pipe(etl.map(function(rowRange) {

        // first load all the offset indices
        return Promise.all(fields.map(field => rowRange.primeOffsetIndex(field.path)))
          .then(offsetIndices => {

            // now we want to break it down so each row range is only on one page per path
            let fieldPageIndices = fields.map(field => rowRange.findRelevantPageIndex(field.path, rowRange.lowIndex));
            let lowIndex = rowRange.lowIndex;

            while (true) {
              let lowestNextPageIndex = Infinity, lowestNextPageFieldIndex = -1;
              for (var i = 0; i < fieldPageIndices.length; i++) {
                let nextPageLocation = offsetIndices[i].page_locations[fieldPageIndices[i] + 1];
                if (nextPageLocation && nextPageLocation.first_row_index < lowestNextPageIndex) {
                  lowestNextPageIndex = nextPageLocation.first_row_index;
                  lowestNextPageFieldIndex = i;
                }
              }

              if (lowestNextPageIndex <= rowRange.highIndex) {
                this.push(rowRange.extend(lowIndex, lowestNextPageIndex - 1));
                fieldPageIndices[lowestNextPageFieldIndex]++;
                lowIndex = lowestNextPageIndex;
              }
              else {
                this.push(rowRange.extend(lowIndex, rowRange.highIndex));
                return;
              }
            }
          });
      }, { concurrency: CONCURRENCY }))
      .pipe(etl.map(function(rowRange) {
        let columnOffsets = fields.map(field => rowRange._offsetIndex[field.path].page_locations);
        let fieldPageIndices = fields.map(field => rowRange.findRelevantPageIndex(field.path, rowRange.lowIndex));
        return Promise.all(fieldPageIndices.map((pageIndex, fieldIndex) => rowRange.pageData(fields[fieldIndex].path, pageIndex)))
          .then(pageData => {
            for (var i = rowRange.lowIndex; i <= rowRange.highIndex; i++) {
              let value = {};
              for (var j = 0; j < fields.length; j++) {
                let path = fields[j].path;
                let pageIndex = fieldPageIndices[j];
                let pageStartIndex = columnOffsets[j][pageIndex].first_row_index;
                value[path] = pageData[j][i - pageStartIndex];
              }
              this.push(value);
            }
          });
      }, { concurrency: CONCURRENCY }));
    });
  }
}

module.exports = PathStreamer;