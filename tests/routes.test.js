const { test } = require("node:test");
const assert = require("node:assert/strict");
const { paths, resolve, group } = require("../routes");

test("every workspace route and legacy tab resolve to the same screen", () => {
  for (const [screen, path] of Object.entries(paths)) {
    assert.equal(resolve(path).screen, screen);
    assert.equal(resolve(`/?tab=${screen}`).screen, screen);
    assert.equal(resolve(`${path}/`).screen, screen);
  }
});
test("shared capsule and collection links take priority over workspace tabs", () => {
  for (const value of ["/c/Ab12Cd34#key=secret", "/?tab=home&id=Ab12Cd34#key=secret", "/?tab=home#data=encrypted&key=secret"]) {
    assert.equal(resolve(value).screen, "receive");
    assert.equal(resolve(value).recipient, true);
  }
  assert.equal(resolve("/r/abcdefghijklmnopqrst#key=secret").screen, "request");
  assert.equal(resolve("/f/abcdefghijklmnopqrst#key=secret").screen, "form");
  assert.equal(resolve("/?id=bad").recipient, false);
  assert.equal(group("file"), group("prompt"));
});

test("large-transfer links retain the recipient route and navigation excludes the body", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(resolve(`/open?transfer=${id}#access=private&key=secret`), { screen:"receive",recipient:true,transfer:id });
  const source = require("node:fs").readFileSync("app.js","utf8");
  assert.ok(source.includes('closest("button[data-screen], a[data-screen]")'));
  assert.ok(!source.includes('closest("[data-screen]")'));
});
