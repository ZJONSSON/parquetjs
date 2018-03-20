const etl = require('etl');
const CONCURRENCY = 500;

const parseFilterPhase = require('./parseFilterPhase');

class FilterMultiItemPhase {
  constructor(items) {
    this.items = items.map(item => parseFilterPhase(item));
  }

  prime(rowRange) {
    let promises = [];
    for (var i = 0; i < this.items.length; i++) {
      promises.push(this.items[i].prime(rowRange));
    }
    return Promise.all(promises).then(d => rowRange);
  }
}

class FilterAndPhase extends FilterMultiItemPhase {
  pipe() {
    let items = this.items;
    return etl.chain(stream => {

      // first warn all our items that this range is coming
      // let them get a jump on some metadata if they want it
      let result = stream.pipe(etl.map(rowRange => {
        if (this.fastFilter(rowRange)) {
          return this.prime(rowRange);
        }
      }, { concurrency: CONCURRENCY }));

      for (var i = 0; i < items.length; i++) {
        let item = items[i];
        result = result.pipe(item.pipe());
      }

      return result;
    });
  }

  fastFilter(rowRange) {
    for (var i = 0; i < this.items.length; i++) {
      if (!this.items[i].fastFilter(rowRange)) {
        return false;
      }
    }
    return true;
  }
}

class FilterOrPhase extends FilterMultiItemPhase {
  
  pipe() {
    let items = this.items;
    return etl.map(function(rowRange) {
      let targetStream = this,
          sentIndices = [],
          startingIndex = rowRange.lowIndex;

      return Promise.all(items.map(item => etl.toStream([rowRange])
        .pipe(item.pipe())
        .pipe(etl.map(rowRange => {
          let lastUnsentStartIndex = undefined;
          for (var i = rowRange.lowIndex; i <= rowRange.highIndex; i++) {
            if (sentIndices[i - startingIndex]) {
              if (lastUnsentStartIndex !== undefined) {
                targetStream.push(rowRange.extend(lastUnsentStartIndex, i - 1));
                lastUnsentStartIndex = undefined;
              }
            }
            else {
              sentIndices[i - startingIndex] = true;
              if (lastUnsentStartIndex === undefined) {
                lastUnsentStartIndex = i;
              }
            }
          }

          if (lastUnsentStartIndex !== undefined) {
            targetStream.push(rowRange.extend(lastUnsentStartIndex, rowRange.highIndex));
          }

        }, { concurrency: CONCURRENCY }))
        .promise()))
      .then(d => {});
    }, { concurrency: CONCURRENCY });
  }


  fastFilter(rowRange) {
    for (var i = 0; i < this.items.length; i++) {
      if (this.items[i].fastFilter(rowRange)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = { FilterOrPhase, FilterAndPhase }