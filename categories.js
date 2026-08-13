// GL categories used to classify invoice line items, and the cost groups they
// roll up into for margin analysis.

const CATEGORIES = [
  { name: 'Produce', group: 'food' },
  { name: 'Meat & Seafood', group: 'food' },
  { name: 'Dairy & Eggs', group: 'food' },
  { name: 'Dry Goods', group: 'food' },
  { name: 'Frozen', group: 'food' },
  { name: 'Bakery', group: 'food' },
  { name: 'Other Food', group: 'food' },
  { name: 'N/A Beverage', group: 'beverage' },
  { name: 'Beer', group: 'alcohol' },
  { name: 'Wine', group: 'alcohol' },
  { name: 'Liquor', group: 'alcohol' },
  { name: 'Paper & Disposables', group: 'supplies' },
  { name: 'Cleaning & Chemicals', group: 'supplies' },
  { name: 'Smallwares', group: 'supplies' },
  { name: 'Repairs & Maintenance', group: 'other' },
  { name: 'Uncategorized', group: 'other' },
];

const GROUPS = {
  food: { label: 'Food', cogs: true },
  beverage: { label: 'N/A Beverage', cogs: true },
  alcohol: { label: 'Alcohol', cogs: true },
  supplies: { label: 'Supplies & Paper', cogs: false },
  other: { label: 'Other', cogs: false },
};

const NAMES = CATEGORIES.map((c) => c.name);
const GROUP_OF = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.group]));

function groupOf(category) {
  return GROUP_OF[category] || 'other';
}

module.exports = { CATEGORIES, GROUPS, NAMES, groupOf };
