const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

const projects = [
  ['payments', 'getPaymentRollingSnapshotPlan'],
  ['invoices', 'getInvoiceRollingSnapshotPlan'],
  ['profit-and-loss', 'getPnlRollingReconciliationPlan'],
  ['balance-sheet', 'getBalanceRollingReconciliationPlan'],
  ['ar-ap', 'getAgingRollingReconciliationPlan'],
  ['journal-entries', 'getJournalRollingReconciliationPlan']
];

test('every report keeps its recurring reconciliation in 7.RollingReconciliation.js', () => {
  projects.forEach(([project, publicPlanner]) => {
    const modulePath = path.join(root, project, '7.RollingReconciliation.js');
    assert.equal(fs.existsSync(modulePath), true, `${project} is missing its rolling module`);

    const source = fs.readFileSync(modulePath, 'utf8');
    assert.match(source, new RegExp(`function\\s+${publicPlanner}\\s*\\(`));

    const projectFiles = fs.readdirSync(path.join(root, project))
      .filter(fileName => /\.(?:js|gs)$/.test(fileName));
    const definitionCount = projectFiles.reduce((count, fileName) => {
      const fileSource = fs.readFileSync(path.join(root, project, fileName), 'utf8');
      const matches = fileSource.match(new RegExp(`function\\s+${publicPlanner}\\s*\\(`, 'g'));
      return count + (matches ? matches.length : 0);
    }, 0);
    assert.equal(definitionCount, 1, `${project} must define ${publicPlanner} exactly once`);
  });
});

test('Payments no longer deploys the completed one-time 2026 history repair', () => {
  assert.equal(fs.existsSync(path.join(root, 'payments', '7.HistoryRepair.js')), false);

  const config = fs.readFileSync(path.join(root, 'payments', '1.Config.js'), 'utf8');
  const backfill = fs.readFileSync(path.join(root, 'payments', '6.Backfill.js'), 'utf8');
  assert.doesNotMatch(config, /PAYMENT_HISTORY_REPAIR_CONFIG/);
  assert.doesNotMatch(backfill, /PaymentHistoryRepair|history repair/i);
});
