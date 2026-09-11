/* The order travels from create-checkout to the webhook inside Stripe
   metadata. Each meal is one row of values joined with ~, rows are joined
   with ;, and the whole string is split across rows_0, rows_1 and so on to
   stay under Stripe's 500-character limit per value.

   The webhook and the parent portal both read orders back through here, so
   the format is described in exactly one place. */

const FIELDS = [
  'date', 'meal', 'choice', 'removals', 'note', 'student',
  'grade', 'allergies', 'portion', 'addOns', 'cents'
];

function unpack(prefix, metadata) {
  let out = '';
  for (let n = 0; metadata && metadata[`${prefix}_${n}`] !== undefined; n++) {
    out += metadata[`${prefix}_${n}`];
  }
  return out;
}

function parseRows(metadata) {
  const packed = unpack('rows', metadata);
  if (!packed) return [];
  return packed.split(';').map((chunk) => {
    const values = chunk.split('~');
    const row = {};
    FIELDS.forEach((field, i) => { row[field] = values[i] || ''; });
    row.removals = row.removals.split('+').filter(Boolean);
    row.addOns = row.addOns.split('+').filter(Boolean);
    row.cents = Number(row.cents) || 0;
    return row;
  });
}

module.exports = { unpack, parseRows, FIELDS };
