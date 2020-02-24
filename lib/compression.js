'use strict';
const zlib = require('zlib');
const snappy = require('snappyjs');
const brotli = require('brotli');

const NOT_SUPPORTED = () => {
  throw new Error('Not Supported in Lite version');
};

const PARQUET_COMPRESSION_METHODS = {
  'UNCOMPRESSED': {
    deflate: deflate_identity,
    inflate: inflate_identity
  },
  'GZIP': {
    deflate: deflate_gzip,
    inflate: inflate_gzip
  },
  'SNAPPY': {
    deflate: deflate_snappy,
    inflate: inflate_snappy
  },
  'LZO': {
    deflate: NOT_SUPPORTED,
    inflate: NOT_SUPPORTED,
  },
  'BROTLI': {
    deflate: deflate_brotli,
    inflate: inflate_brotli,
  }
};

/**
 * Deflate a value using compression method `method`
 */
function deflate(method, value) {
  if (!(method in PARQUET_COMPRESSION_METHODS)) {
    throw 'invalid compression method: ' + method;
  }

  return PARQUET_COMPRESSION_METHODS[method].deflate(value);
}

function deflate_identity(value) {
  return value;
}

function deflate_gzip(value) {
  return zlib.gzipSync(value);
}

function deflate_snappy(value) {
  return snappy.compress(value);
}

function deflate_lzo(value) {
  return get_lzo().compress(value);
}

function deflate_brotli(value) {
  return Buffer.from(brotli.compress(value, {
    mode: 0,
    quality: 8,
    lgwin: 22
  }));
}

/**
 * Inflate a value using compression method `method`
 */
function inflate(method, value) {
  if (!(method in PARQUET_COMPRESSION_METHODS)) {
    throw 'invalid compression method: ' + method;
  }

  return PARQUET_COMPRESSION_METHODS[method].inflate(value);
}

function inflate_identity(value) {
  return value;
}

function inflate_gzip(value) {
  return zlib.gunzipSync(value);
}

function inflate_snappy(value) {
  return snappy.uncompress(value);
}

function inflate_lzo(value) {
  return get_lzo().decompress(value);
}

function inflate_brotli(value) {
  return Buffer.from(brotli.decompress(value));
}

module.exports = { PARQUET_COMPRESSION_METHODS, deflate, inflate };

