module.exports = class BufferReader {
  constructor(envelopeReader, options) {
    options = options || {};
    this.envelopeReader = envelopeReader;
    this.maxSpan = options.maxSpan || 300000; // 100k
    this.maxLength = options.maxLength || 10000000; // 10mb
    this.queueWait = options.queueWait || 5;
    this.scheduled = undefined;
    this.queue = [];
  }

  read(offset, length) {
    clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => this.processQueue(), this.queueWait);

    return new Promise( (resolve, reject) => {
      this.queue.push({offset,length,resolve,reject});
    });
  }

  processQueue() {
    const queue = this.queue;
    if (!queue.length) return;
    this.queue = [];
    queue.sort( (a,b) => a.offset - b.offset);

    var subqueue = [];

    const readSubqueue = () => {
      if (!subqueue.length) {
        return;
      }

      const processQueue = subqueue;
      subqueue = [];

      const lastElement = processQueue[processQueue.length-1];
      const start = processQueue[0].offset;
      const finish = lastElement.offset +lastElement.length;
      this.envelopeReader.readFn(start, finish - start).then(buffer => {
        processQueue.forEach(d => {
          d.resolve(buffer.slice(d.offset - start, d.offset + d.length - start));
        });
      });
    };

    queue.forEach((d,i) => {
      const prev = queue[i-1];
      if (!prev || (d.offset - (prev.offset + prev.length)) < this.maxSpan) {
        subqueue.push(d);
        if ( (d.offset + d.length) - subqueue[0].offset > this.maxLength) {
          readSubqueue();
        }
      } else {
        readSubqueue();
        subqueue = [d];
      }
    });
    readSubqueue(subqueue);
  }
};