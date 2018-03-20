const etl = require('etl');
const BloomFilter = require('bloomfilter').BloomFilter;
const CONCURRENCY = 500;

const NUMBER_OF_BITS = 4096,
      NUMBER_OF_HASHES = 3;

class BloomFilterPhase {

  constructor(spec) {
    this.path = spec.path;

    let prepFilter = new BloomFilter(NUMBER_OF_BITS, NUMBER_OF_HASHES);
    this.values = [].concat(spec.bloom).map(v => prepFilter.prepBatch(v));
  }

  prime(rowRange) {
    return rowRange.prime(this.path, true, false);
  }

  fastFilter() {
    return true;
  }

  pipe() {
    let path = this.path,
        values = this.values;

    return etl.chain(stream => {

      // split this into messages in pipe per page 
      // to be handle pressure
      return stream.pipe(etl.map(function(rowRange) {
        let columnOffsets = rowRange._offsetIndex[path].page_locations;
        let startingPage = rowRange.findRelevantPageIndex(path, rowRange.lowIndex);
        let endingPage = rowRange.findRelevantPageIndex(path, rowRange.highIndex);

        for (var i = startingPage; i <= endingPage; i++) {
          let startIndex = i === startingPage ? rowRange.lowIndex : columnOffsets[i].first_row_index;
          let endingIndex = i === endingPage ? rowRange.highIndex : columnOffsets[i + 1].first_row_index - 1;

          this.push(rowRange.extend(startIndex, endingIndex));
        }
      }, { concurrency: CONCURRENCY }))
      .pipe(etl.map(function(rowRange) {
        // we know that row range is now in one and only page  
        let target = this;
        let pageIndex = rowRange.findRelevantPageIndex(path, rowRange.lowIndex);
        return rowRange.bloomFilter(path, pageIndex).then(bloomFilter => {
          for (var i = 0; i < values.length; i++) {
            if (bloomFilter.testBatch(values[i])) {
              target.push(rowRange);
              return;
            }
          }
        });
      }, { concurrency: CONCURRENCY }));
    });
  }
}

module.exports = { BloomFilterPhase };