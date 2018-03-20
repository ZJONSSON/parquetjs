const etl = require('etl');
const CONCURRENCY = 500;

//
// Handle fast filters of records by looking at indices
//
class FilterIndexPhase {

  constructor(path) {
    this.path = path;
  }

  fastFilter(rowRange) {
    // can we cancel this out immediately?  if so let's do that
    let rowRangeMinValue = rowRange.minValue(this.path),
        rowRangeMaxValue = rowRange.maxValue(this.path);
    if (rowRangeMinValue !== undefined && rowRangeMaxValue !== undefined &&
        !this.evaluate(rowRangeMinValue, rowRangeMaxValue)) {
      return false;
    }
    return true;
  }

  prime(rowRange) {
    return rowRange.prime(this.path, true, true);
  }

  pipe() {
    let path = this.path,
        evaluate = this.evaluate.bind(this),
        fastFilter = this.fastFilter.bind(this);

    return etl.map(function(rowRange) {

      if (!fastFilter(rowRange)) {
        return;
      }

      let columnIndex = rowRange._columnIndex[path];
      let columnOffsets = rowRange._offsetIndex[path].page_locations;
      let startingPage = rowRange.findRelevantPageIndex(path, rowRange.lowIndex);
      let endingPage = rowRange.findRelevantPageIndex(path, rowRange.highIndex);

      let nextRangeStartingIndex = undefined,
          nextRangeEndIndex = undefined,
          nextRangeLowValue = undefined,
          nextRangeHighValue = undefined;

      for (var i = startingPage; i <= endingPage; i++) {
        let maxValue = columnIndex.max_values[i];
        let minValue = columnIndex.min_values[i];

        if (evaluate(minValue, maxValue)) {
          // extend or build new range
          nextRangeEndIndex = Math.min(rowRange.highIndex, i < columnOffsets.length - 1 ? columnOffsets[i + 1].first_row_index - 1 : Infinity);
          if (nextRangeStartingIndex === undefined) {
            nextRangeStartingIndex = Math.max(rowRange.lowIndex, columnOffsets[i].first_row_index);
            nextRangeLowValue = minValue;
            nextRangeHighValue = maxValue;
          }
          else {
            nextRangeLowValue = nextRangeLowValue < minValue ? nextRangeLowValue : minValue;
            nextRangeHighValue = nextRangeHighValue > maxValue ? nextRangeHighValue : maxValue;
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

    }, { concurrency: CONCURRENCY });
  }
}

class FilterRangeIndexPhase extends FilterIndexPhase {
  constructor(spec) {
    super(spec.path);
    this.min = spec.min;
    this.max = spec.max;
    this.sMin = spec.min === undefined ? undefined : String(spec.min);
    this.sMax = spec.max === undefined ? undefined : String(spec.max);
  }

  evaluate(minValue, maxValue) {
    if (this.max !== undefined && this.max < minValue) {
      return false;
    }
    if (this.min !== undefined && this.min > maxValue) {
      return false;
    }
    return true;
  }
}

class FilterValueIndexPhase extends FilterIndexPhase {
  constructor(spec) {
    super(spec.path);
    this.value = spec.value;
    this.sValue = String(spec.value);
  }

  evaluate(minValue, maxValue) {
    if (minValue > this.value) {
      return false;
    }
    if (maxValue < this.value) {
      return false;
    }
    return true;
  }
}

class FilterInIndexPhase extends FilterIndexPhase {
  constructor(spec) {
    super(spec.path);

    this.value = spec.in
  }

  evaluate(minValue, maxValue) {
    for (var i = 0; i < this.value.length; i++) {
      if (minValue <= this.value[i] && this.value[i] <= maxValue) {
        return true;
      }
    }
    return false;
  }
}

class LoadIndex extends FilterIndexPhase {
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

module.exports = { FilterValueIndexPhase, FilterRangeIndexPhase, FilterInIndexPhase, LoadIndex }