'use strict';
const parquet_types = require('./types');
const parquet_schema = require('./schema');

/**
 * 'Shred' a record into a list of <value, repetition_level, definition_level>
 * tuples per column using the Google Dremel Algorithm..
 *
 * The buffer argument must point to an object into which the shredded record
 * will be returned. You may re-use the buffer for repeated calls to this function
 * to append to an existing buffer, as long as the schema is unchanged.
 *
 * The format in which the shredded records will be stored in the buffer is as
 * follows:
 *
 *   buffer = {
 *     columnData: [
 *       'my_col': {
 *          dlevels: [d1, d2, .. dN],
 *          rlevels: [r1, r2, .. rN],
 *          values: [v1, v2, .. vN],
 *        }, ...
 *      ],
 *      rowCount: X,
 *   }
 *
 */
exports.shredRecord = function(schema, record, buffer) {
  /* shred the record, this may raise an exception */
  var recordShredded = {};
  for (let field of schema.fieldList) {
    recordShredded[field.path] = {
      dlevels: [],
      rlevels: [],
      values: [],
      count: 0
    };
  }

  shredRecordInternal(schema.fields, record, recordShredded, 0, 0);

  /* if no error during shredding, add the shredded record to the buffer */
  if (!('columnData' in buffer) || !('rowCount' in buffer)) {
    buffer.rowCount = 0;
    buffer.pageRowCount = 0;
    buffer.columnData = {};
    buffer.pages = {};

    for (let field of schema.fieldList) {
      buffer.columnData[field.path] = {
        dlevels: [],
        rlevels: [],
        values: [],
        count: 0
      };
      buffer.pages[field.path] = [];
    }
  }

  buffer.rowCount += 1;
  buffer.pageRowCount += 1;
  for (let field of schema.fieldList) {
    let record = recordShredded[field.path];
    let column = buffer.columnData[field.path];

    for (let i = 0; i < record.rlevels.length; i++) {
      column.rlevels.push(record.rlevels[i]);
      column.dlevels.push(record.dlevels[i]);
      if (record.values[i] !== undefined) {
        column.values.push(record.values[i]);
      }
    }

    column.count += record.count;
  }
};

function shredRecordInternal(fields, record, data, rlvl, dlvl) {
  for (let fieldName in fields) {
    const field = fields[fieldName];
    const fieldType = field.originalType || field.primitiveType;

    // fetch values
    let values = [];
    if (record && (fieldName in record) && record[fieldName] !== undefined && record[fieldName] !== null) {
      if (record[fieldName].constructor === Array) {
        values = record[fieldName];
      } else {
        values.push(record[fieldName]);
      }
    }

    // check values
    if (values.length == 0 && !!record && field.repetitionType === 'REQUIRED') {
      throw 'missing required field: ' + field.name;
    }

    if (values.length > 1 && field.repetitionType !== 'REPEATED') {
      throw 'too many values for field: ' + field.name;
    }

    // push null
    if (values.length == 0) {
      if (field.isNested) {
        shredRecordInternal(
            field.fields,
            null,
            data,
            rlvl,
            dlvl);
      } else {
        data[field.path].rlevels.push(rlvl);
        data[field.path].dlevels.push(dlvl);
        data[field.path].count += 1;
      }
      continue;
    }

    // push values
    for (let i = 0; i < values.length; ++i) {
      const rlvl_i = i === 0 ? rlvl : field.rLevelMax;

      if (field.isNested) {
        shredRecordInternal(
            field.fields,
            values[i],
            data,
            rlvl_i,
            field.dLevelMax);
      } else {
        try {
          data[field.path].values.push(parquet_types.toPrimitive(fieldType, values[i]));
          data[field.path].rlevels.push(rlvl_i);
          data[field.path].dlevels.push(field.dLevelMax);
          data[field.path].count += 1;
        } catch(e) {
          throw `${e.message || e} for field ${field.path}`;
        }
      }
    }
  }
}

/**
 * 'Materialize' a list of <value, repetition_level, definition_level>
 * tuples back to nested records (objects/arrays) using the Google Dremel
 * Algorithm..
 *
 * The buffer argument must point to an object with the following structure (i.e.
 * the same structure that is returned by shredRecords):
 *
 *   buffer = {
 *     columnData: [
 *       'my_col': {
 *          dlevels: [d1, d2, .. dN],
 *          rlevels: [r1, r2, .. rN],
 *          values: [v1, v2, .. vN],
 *        }, ...
 *      ],
 *      rowCount: X,
 *   }
 *
 */
exports.materializeRecords = function(schema, buffer, records) {
  if (!records) {
    records = [];
  }

  for (let k in buffer.columnData) {
    const field = schema.findField(k);
    const paths = field.path;
    let values = this.materializeValues(schema, k, buffer.columnData[k]);
    for (var i = 0; i < values.length; i++) {
      let record = records[i];
      if (!record) {
        record = {};
        records[i] = record;
      }

      if (paths.length === 1) {
        if (values[i] !== undefined) {
          record[k] = values[i];
        }
      }
      else {
        mergeDeep(record, values[i], paths, 0);
      }
    }
  }

  return records;
}

function mergeDeep(target, value, paths, pathIndex) {
  let targetPath = paths[pathIndex];
  let result = undefined;

  if (Array.isArray(value) && pathIndex < paths.length - 1) {
    result = target[targetPath] || [];

    for (var i = 0; i < value.length; i++) {
      var v = result[i] || (result[i] = {});
      mergeDeep(v, value[i], paths, pathIndex + 1);
    }
  }
  else if (pathIndex < paths.length - 1) {
    if (value) {
      result = target[targetPath] || {};
      mergeDeep(result, value[paths[pathIndex + 1]], paths, pathIndex + 1);
    }
  }
  else {
    result = value;
  }

  if (result !== undefined) {
    target[targetPath] = result;
  }
  return target;
}

exports.materializeValues = function(schema, fieldName, columnData) {
  let records = [],
      lastRecordValue = null,
      lastRecordIndex = -1,
      shouldPushRecord = false;

  const field = schema.findField(fieldName);
  const fieldBranch = schema.findFieldBranch(fieldName);
  let values = columnData.values[Symbol.iterator]();

  let rLevels = new Array(field.rLevelMax + 1);
  rLevels.fill(0);

  for (let i = 0; i < columnData.count; ++i) {
    const dLevel = columnData.dlevels[i];
    const rLevel = columnData.rlevels[i];

    rLevels[rLevel]++;
    if (field.rLevelMax > 0) {
      rLevels.fill(0, rLevel + 1);
    }

    let value = null;
    if (dLevel === field.dLevelMax) {
      value = parquet_types.fromPrimitive(
          field.originalType || field.primitiveType,
          values.next().value);
    }

    let index = rLevels[0] - 1;
    if (index > lastRecordIndex) {
      lastRecordValue = null;
      lastRecordIndex = index;
      shouldPushRecord = true;
    }

    lastRecordValue = materializeRecordValue(
        lastRecordValue,
        fieldBranch,
        0,
        rLevels,
        1,
        dLevel,
        value);

    if (shouldPushRecord) {
      shouldPushRecord = false;
      records.push(lastRecordValue);
    }
  }


  return records;
}


function materializeRecordValue(recordValue, branch, branchIndex, rLevels, rLevelIndex, dLevel, value) {
  const node = branch[branchIndex];

  if (dLevel < node.dLevelMax) {
    return;
  }

  if (branch.length > branchIndex + 1) {
    if (node.repetitionType === "REPEATED") {
      if (!recordValue) {
        recordValue = [];
      }

      while (recordValue.length < rLevels[rLevelIndex] + 1) {
        recordValue.push([]);
      }

      recordValue[rLevels[rLevelIndex]] = materializeRecordValue(
          recordValue[rLevels[rLevelIndex]],
          branch,
          branchIndex + 1,
          rLevels,
          rLevelIndex + 1,
          dLevel,
          value);
    } else {
      if (!recordValue) {
        recordValue = {};
      }

      let nextBranch = branch[branchIndex + 1];
      let nextBranchName = nextBranch.name;
      let materializeRecordResult = materializeRecordValue(
          branchIndex === 0 ? null : recordValue[nextBranchName],
          branch,
          branchIndex + 1,
          rLevels,
          rLevelIndex,
          dLevel,
          value);

      if (materializeRecordResult !== undefined) {
        recordValue[nextBranchName] = materializeRecordResult;
      }
    }
  } else {
    if (node.repetitionType === "REPEATED") {
      if (!recordValue) {
        recordValue = [];
      }

      while (recordValue.length < rLevels[rLevelIndex] + 1) {
        recordValue.push(null);
      }

      recordValue[rLevels[rLevelIndex]] = value;
    }
    else {
      recordValue = value;
    }
  }
  return recordValue;
}