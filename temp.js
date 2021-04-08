const parquet = require("./parquet.js")

var schema = new parquet.ParquetSchema({
    name: { type: 'UTF8' },
    quantity: { type: 'INT64' },
    price: { type: 'DOUBLE' },
    date: { type: 'TIMESTAMP_MILLIS' },
    in_stock: { type: 'BOOLEAN' }
});
  
(async () => {
    const options = {
        bloomFilters: [{column: "name", size: 1000}]
    }

    const writer = await parquet.ParquetWriter.openFile(schema, 'fruits.parquet', options);
    await writer.appendRow({name: 'apples and banannas', quantity: 10, price: 2.5, date: new Date(), in_stock: true});
    await writer.appendRow({name: 'oranges', quantity: 10, price: 2.5, date: new Date(), in_stock: true});
    const close = await writer.close();
    console.log("close", close);

    // console.log('****hereee**************************************************************************');
    // const reader = await parquet.ParquetReader.openFile('./fruits.parquet');

    // const meta = await reader.getMetadata();
    // console.log("meta", meta)
})();
// {
//     body: <Buffer 15 06 15 20 15 20 5c 15 04 15 00 15 04 15 00 15 00 15 00 12 1c 18 08 0a 00 00 00 00 00 00 00 18 08 0a 00 00 00 00 00 00 00 16 00 16 02 18 08 0a 00 00 ... 111 more bytes>,
//     metadata: {
//       type: 2,
//       encodings: [ 3, 0 ],
//       path_in_schema: [ 'quantity' ],
//       codec: 0,
//       num_values: 2,
//       total_uncompressed_size: 84,
//       total_compressed_size: 84,
//       key_value_metadata: null,
//       data_page_offset: 153,
//       index_page_offset: null,
//       dictionary_page_offset: null,
//       statistics: {
//         max: <Buffer 0a 00 00 00 00 00 00 00>,
//         min: <Buffer 0a 00 00 00 00 00 00 00>,
//         null_count: 0,
//         distinct_count: 1,
//         max_value: <Buffer 0a 00 00 00 00 00 00 00>,
//         min_value: <Buffer 0a 00 00 00 00 00 00 00>
//       },
//       encoding_stats: null,
//       offsetIndex: { page_locations: [Array] },
//       columnIndex: {
//         null_pages: null,
//         min_values: [Array],
//         max_values: [Array],
//         boundary_order: null,
//         null_counts: null
//       }
//     },
//     metadataOffset: 237
//   }