// Fictional travel inventory for the demo. Every merchant here is made up.

export const TRIPS = {
  lisbon: {
    title: 'Lisbon, 3 nights (Nov 20–23)',
    nights: 3,
    options: [
      { id: 'h1', category: 'hotel', merchant: 'Palácio Azul Hotel', unitPrice: 240, attributes: { rating: 4.9, cancellation_fee: false }, note: 'Rooftop pool, Chiado' },
      { id: 'h2', category: 'hotel', merchant: 'Casa do Rio', unitPrice: 138, attributes: { rating: 4.6, cancellation_fee: true }, note: 'River view, non-refundable rate' },
      { id: 'h3', category: 'hotel', merchant: 'Alfama Loft Suites', unitPrice: 129, attributes: { rating: 4.5, cancellation_fee: false }, note: 'Free cancellation, old town' },
      { id: 'h4', category: 'hotel', merchant: 'Budget Inn Lisboa', unitPrice: 59, attributes: { rating: 3.4, cancellation_fee: false }, note: 'Shared bathroom' },

      { id: 'f1', category: 'flight', merchant: 'SkyLuxe Air', unitPrice: 520, attributes: { rating: 4.8 }, time: '09:10', note: 'Direct, extra legroom' },
      { id: 'f2', category: 'flight', merchant: 'Atlantic Wings', unitPrice: 310, attributes: { rating: 4.4 }, time: '13:40', note: 'Direct' },
      { id: 'f3', category: 'flight', merchant: 'CheapHop', unitPrice: 140, attributes: { rating: 3.1, basic_economy: true, overnight_layover: true }, time: '23:55', note: 'Overnight layover' },

      { id: 'd1', category: 'dinner', merchant: 'Belcanto Tasting Room', unitPrice: 210, attributes: { rating: 4.9 }, time: '23:30', note: 'Late tasting menu' },
      { id: 'd2', category: 'dinner', merchant: 'Tasca do Bairro', unitPrice: 48, attributes: { rating: 4.7 }, time: '20:00', note: 'Local favourite' },

      { id: 'a1', category: 'activity', merchant: 'Sintra Day Tours', unitPrice: 75, attributes: { rating: 4.8 }, time: '09:00', note: 'Palaces of Sintra' },
    ],
  },
};

/** Expand an option into a concrete purchase (hotels are priced per night). */
export function toPurchase(option, trip) {
  const qty = option.category === 'hotel' ? trip.nights : 1;
  return {
    optionId: option.id,
    category: option.category,
    merchant: option.merchant,
    unitPrice: option.unitPrice,
    quantity: qty,
    amount: Math.round(option.unitPrice * qty * 100) / 100,
    attributes: option.attributes || {},
    time: option.time,
    note: option.note,
  };
}
