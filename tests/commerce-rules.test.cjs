const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
test("Firestore contract makes every order write server-only including owner admin", () => {
  const rules = fs.readFileSync(
    path.join(__dirname, "../firestore.rules"),
    "utf8",
  );
  const orderBlock = rules.match(
    /match \/orders\/\{orderId\} \{([\s\S]*?)\n\s*\}/,
  )?.[1];
  assert.ok(orderBlock);
  assert.match(orderBlock, /allow create, update, delete: if false/);
  assert.match(orderBlock, /resource\.data\.customerUid == request\.auth\.uid/);
  assert.match(orderBlock, /request\.auth\.token\.admin == true/);
  const settingsBlock = rules.match(/match \/settings\/\{settingId\} \{([\s\S]*?)\n\s*\}/)?.[1];
  assert.ok(settingsBlock);
  assert.match(settingsBlock, /allow read: if settingId == 'promotions';/);
  assert.doesNotMatch(settingsBlock, /settingId == 'delivery'/);
  assert.match(settingsBlock, /allow write: if false;/);
  for (const collection of ["stripeEvents", "paymentBindings"])
    assert.match(
      rules,
      new RegExp(
        `match /${collection}/\\{[^}]+\\} \\{\\s*allow read, write: if false`,
      ),
    );
});
