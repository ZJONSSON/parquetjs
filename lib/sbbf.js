const Long = require('long');

const salt = [
  0x47b6137b,
  0x44974d91,
  0x8824ad5b,
  0xa2b7289d,
  0x705495c7,
  0x2df1424b,
  0x9efc4947,
  0x5c6bfb31
];

function initBlock() {
  return Uint32Array.from(Array(8).fill(0));
}

function initSplitBlocks(z) {
  return Array(z).fill(initBlock());
}

function mask(x) {
  let result = initBlock();

  for (let i = 0; i < 8; i++) {
      const y = x * salt[i];
      result[i] = result[i] | (1 << (y >>> 27));
  }
  return result;
}

function blockInsert(b, x) {
  const masked = mask(x);

  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 31; j++) {
      const isSet = masked[i] & (2 ** j);
      if (isSet) {
          b[i] = b[i] | (2 ** j);
      }
    }
  }
}

function blockCheck(b, x) {
  const masked = mask(x);

  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 31; j++) {
      const isSet = masked[i] & (2 ** j);
      if (isSet) {
        const match = b[i] & (2 ** j);
        if (!match) {
          return false;
        }
      }
    }
  }

  return true;
}

function getBlockIndex(h, z) {
  const zLong = Long.fromNumber(z, true);
  const h_top_bits = Long.fromNumber(h.getHighBitsUnsigned(), true);

  return h_top_bits.mul(zLong).shiftRightUnsigned(32).getLowBitsUnsigned();
}

function filterInsert(filter, x) {
  const i = getBlockIndex(x, filter.length);
  const block = filter[i];

  blockInsert(block, x.getLowBitsUnsigned());
}

function filterCheck(filter, x) {
  const i = getBlockIndex(x, filter.length);

  const block = filter[i];

  return blockCheck(block, x.getLowBitsUnsigned());
}

module.exports = {
  initSplitBlocks,
  filterInsert,
  filterCheck
}
