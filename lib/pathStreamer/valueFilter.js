const etl = require('etl');
const CONCURRENCY = 500;

//
// Handle slow filters of records 
//
class FilterPhase {

  constructor(path) {
    this.path = path;
  }

  prime(rowRange) {
    return rowRange.prime(this.path, true, false);
  }

  fastFilter(rowRange) {
    return true;
  }

  fastPass(rowRange) {
    return false;
  }

  pipe() {
    let path = this.path,
        evaluate = this.evaluate.bind(this),
        fastFilter = this.fastFilter.bind(this),
        fastPass = this.fastPass.bind(this);

    return etl.chain(stream => {

      // split this into messages in pipe per page 
      // to be handle pressure
      return stream.pipe(etl.map(function(rowRange) {
        if (!fastFilter(rowRange)) {
          return;
        }
        if (fastPass(rowRange)) {
          this.push(rowRange);
          return;
        }

        let columnIndex = rowRange._columnIndex[path];
        let columnOffsets = rowRange._offsetIndex[path].page_locations;
        let startingPage = rowRange.findRelevantPageIndex(path, rowRange.lowIndex);
        let endingPage = rowRange.findRelevantPageIndex(path, rowRange.highIndex);

        for (var i = startingPage; i <= endingPage; i++) {
          let startIndex = i === startingPage ? rowRange.lowIndex : columnOffsets[i].first_row_index;
          let endingIndex = i === endingPage ? rowRange.highIndex : columnOffsets[i + 1].first_row_index - 1;

          if (columnIndex) {
            this.push(rowRange.extend(startIndex, endingIndex, path, columnIndex.min_values[i], columnIndex.max_values[i]));
          }
          else {
            this.push(rowRange.extend(startIndex, endingIndex));
          }
        }
      }, { concurrency: CONCURRENCY }))
      .pipe(etl.map(function(rowRange) {
        if (fastPass(rowRange)) {
          this.push(rowRange);
          return;
        }

        // we know that row range is now in one and only page  
        let columnOffsets = rowRange._offsetIndex[path].page_locations;
        let pageIndex = rowRange.findRelevantPageIndex(path, rowRange.lowIndex);
        let startingPageRowIndex = columnOffsets[pageIndex].first_row_index;
        return rowRange.pageData(path, pageIndex).then(values => {

          let nextRangeStartingIndex = undefined,
              nextRangeEndIndex = undefined,
              nextRangeLowValue = undefined,
              nextRangeHighValue = undefined;

          for (var i = rowRange.lowIndex; i <= rowRange.highIndex; i++) {
            let relativeIndex = i - startingPageRowIndex;
            let value = values[relativeIndex];
            if (evaluate(value)) {
              // extend or build new range
              nextRangeEndIndex = i;
              if (nextRangeStartingIndex === undefined) {
                nextRangeStartingIndex = i;
                nextRangeLowValue = value;
                nextRangeHighValue = value;
              }
              else {
                nextRangeLowValue = nextRangeLowValue < value ? nextRangeLowValue : value;
                nextRangeHighValue = nextRangeHighValue > value ? nextRangeHighValue : value;
              }
            }
            else if (nextRangeStartingIndex !== undefined) {
              // flush the next range (if we have it)
              this.push(rowRange.extend(nextRangeStartingIndex, nextRangeEndIndex, path, nextRangeLowValue, nextRangeHighValue));
              nextRangeStartingIndex = undefined;
              nextRangeLowValue = undefined;
              nextRangeHighValue = undefined;
              nextRangeEndIndex = undefined;
            }
          }

          // leftover end range?
          if (nextRangeStartingIndex !== undefined) {
            this.push(rowRange.extend(nextRangeStartingIndex, nextRangeEndIndex, path, nextRangeLowValue, nextRangeHighValue));
          }
        })
      }, { concurrency: CONCURRENCY }));
    });
  }
}

class FilterRangePhase extends FilterPhase {
  constructor(spec) {
    super(spec.path);
    this.min = spec.min;
    this.max = spec.max;
    this.sMin = spec.min === undefined ? undefined : String(spec.min);
    this.sMax = spec.max === undefined ? undefined : String(spec.max);
  }

  fastFilter(rowRange) {
    // can we cancel this out immediately?  if so let's do that
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue !== undefined &&
        (this.max !== undefined && rowRangeMinValue > this.max) || (this.min !== undefined && rowRangeMaxValue < this.min)) {
      return false;
    }
    return true;
  }

  fastPass(rowRange) {
    // can we pass the whole range immediatley?  if so, let's not read the data
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue !== undefined &&
        (this.min === undefined || rowRangeMinValue > this.min) && (this.max === undefined || rowRangeMaxValue < this.max)) {
      return true;
    }
    return false;
  }

  evaluate(value) {
    if (this.max !== undefined && this.max < value) {
      return false;
    }
    if (this.min !== undefined && this.min > value) {
      return false;
    }
    return true;
  }

}

class FilterValuePhase extends FilterPhase {
  constructor(spec) {
    super(spec.path);
    this.value = spec.value;
    this.sValue = String(spec.value);
  }

  evaluate(value) {
    return value == this.value;
  }

  fastFilter(rowRange) {
    // can we cancel this out immediately?  if so let's do that
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue !== undefined &&
        (rowRangeMinValue > this.value || rowRangeMaxValue < this.value)) {
      return false;
    }
    return true;
  }

  fastPass(rowRange) {
    // can we pass the whole range immediatley?  if so, let's not read the data
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue === rowRangeMinValue &&
        rowRangeMinValue == this.value) {
      return true;
    }
    return false;
  }
}


class FilterInPhase extends FilterPhase {
  constructor(spec) {
    super(spec.path);
    this.value = new Set(spec.in);

    this.min = spec.in.reduce((min, value) => min < value ? min : value);
    this.max = spec.in.reduce((max, value) => max > value ? max : value);
  }

  evaluate(value) {
    return this.value.has(value);
  }

  fastFilter(rowRange) {
    // can we cancel this out immediately?  if so let's do that
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue !== undefined &&
        (rowRangeMinValue > this.max) || (rowRangeMaxValue < this.min)) {
      return false;
    }
    return true;
  }

  fastPass(rowRange) {
    return false;
  }
}

class LoadOffset extends FilterPhase {
  constructor(spec) {
    super(spec.path);
  }

  evaluate(value) {
    return true;
  }

  pipe() {
    return etl.map(d => {
      return d;
    }, { concurrency: CONCURRENCY })
  }
}

module.exports = { FilterRangePhase, FilterValuePhase, FilterInPhase, LoadOffset };