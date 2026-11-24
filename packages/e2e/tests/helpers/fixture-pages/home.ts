/** The home page and the plain control pages most suites open. */

import { constant, type PageRenderer } from './page.ts';

export const HOME_PAGES: Record<string, PageRenderer> = {
  '/': constant(`<!doctype html>
<html>
<head><title>Fixture Home</title></head>
<body>
  <h1>Home</h1>
  <a href="/about">About</a>
  <a href="/about?token=super-secret-token#frag">About with token</a>
  <button id="increment" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Increment</button>
  <output id="count" role="status" aria-label="Counter">0</output>

  <label for="email">Email</label>
  <input id="email" type="email" placeholder="you@example.test" autocomplete="username" />

  <label for="readonly">Readonly</label>
  <input id="readonly" readonly value="read-only value" />

  <div id="class-card" class="card active" data-extra="node-only" constructor="own">Card</div>
  <img id="fixture-image" src="/fixture.png" alt="Fixture" />

  <label for="focus-target">Focus target</label>
  <input id="focus-target" />

  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="current-password" />

  <label for="notifications">Notifications</label>
  <input id="notifications" type="checkbox" />

  <label for="plan">Plan</label>
  <select id="plan">
    <option value="free">Free</option>
    <option value="pro">Pro</option>
    <option value="team">Team</option>
  </select>

  <label for="digest">Digest</label>
  <select id="digest" multiple>
    <option value="daily">Daily</option>
    <option value="weekly">Weekly</option>
    <option value="monthly">Monthly</option>
  </select>

  <button disabled>Disabled action</button>
  <fieldset disabled>
    <legend>Fenced <button>Legend action</button></legend>
    <button>Fenced action</button>
  </fieldset>
  <div hidden>Hidden content</div>
  <svg data-testid="hidden-svg" width="40" height="40" style="visibility:hidden"><rect width="40" height="40"></rect></svg>
  <div data-testid="zero-box" style="width:0;height:0;overflow:hidden"><span>Clipped away</span></div>
  <details><summary>Folded</summary><button>Inside folded details</button></details>
  <div data-testid="empty-contents" style="display:contents"></div>
  <div data-testid="painted-contents" style="display:contents"><span>Laid out by contents</span></div>
  <button aria-expanded="false" id="menu" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">Menu</button>

  <ul data-testid="items">
    <li data-testid="item">Item Alpha</li>
    <li data-testid="item">Item Beta</li>
    <li data-testid="item">Item Gamma</li>
  </ul>
  <span>Duplicated</span>
  <span>Duplicated</span>

  <input id="prefilled" aria-label="Prefilled" value="hello-value" />
  <textarea id="notes" aria-label="Notes">line1

line2  </textarea>

  <script>
    setTimeout(() => {
      const late = document.createElement('button');
      late.textContent = 'Late arrival';
      document.body.appendChild(late);
    }, 400);
  </script>
</body>
</html>`),
  // Composite widgets under the roles a ported Playwright test names.
  '/roles': constant(`<!doctype html>
<html>
<head><title>Roles</title></head>
<body>
  <h1>Roles</h1>
  <img id="logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" alt="Fixture logo" />
  <div role="img" aria-label="Sales chart" style="width:80px;height:40px;background:#ccc"></div>
  <div role="tablist" aria-label="Filter">
    <button role="tab" aria-selected="true" aria-controls="all-panel" id="all-tab">All</button>
    <button role="tab" aria-selected="false" aria-controls="open-panel" id="open-tab">Open</button>
  </div>
  <div role="tabpanel" id="all-panel" aria-labelledby="all-tab">Everything</div>
  <div role="toolbar" aria-label="Formatting">
    <button aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')">Bold</button>
    <input type="number" aria-label="Font size" value="12" />
  </div>
  <button aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('view-menu').hidden = false; this.setAttribute('aria-expanded', 'true')">View</button>
  <div role="menu" id="view-menu" aria-label="View" hidden>
    <div role="menuitem" tabindex="0">Zoom in</div>
    <div role="menuitemcheckbox" aria-checked="true" tabindex="0">Show grid</div>
  </div>
  <progress aria-label="Upload" value="4" max="10"></progress>
  <fieldset><legend>Notifications</legend><input type="checkbox" aria-label="Email" /></fieldset>
  <form aria-label="Sign in"><input aria-label="User" /></form>
  <hr />
  <article aria-label="First post"><p>Body</p></article>
  <div role="switch" aria-checked="false" tabindex="0">Dark mode</div>
  <table><tr><th scope="col">Plan</th><td>Monthly</td></tr></table>
  <x-button role="button" tabindex="0"></x-button>
  <input type="reset" value="Clear form" />
  <input type="reset" />
  <script>
    document.querySelector('x-button').attachShadow({ mode: 'open' }).innerHTML = '<span>Shadow action</span>';
  </script>
</body>
</html>`),
  // Class assertions: a node that arrives late, duplicates, and the two
  // shapes of an empty class. Its own page so the late node never lands in
  // another suite's screen diff.
  '/classes': constant(`<!doctype html>
<html>
<head><title>Classes</title></head>
<body>
  <h1>Classes</h1>
  <span class="dup">Duplicated</span>
  <span class="dup">Duplicated</span>
  <div id="blank-card" class="">Blank</div>
  <ul data-testid="items"><li>Item</li></ul>
  <script>
    setTimeout(() => {
      const card = document.createElement('div');
      card.id = 'late-card';
      card.className = 'card late';
      card.textContent = 'Late card';
      document.body.appendChild(card);
    }, 600);
  </script>
</body>
</html>`),
  '/about': constant(`<!doctype html>
<html>
<head><title>About page</title></head>
<body>
  <h1>About</h1>
  <a href="/">Home</a>
</body>
</html>`),
  '/storage': constant(`<!doctype html>
<html>
<head><title>Storage</title></head>
<body>
  <h1>Storage</h1>
  <button onclick="localStorage.setItem('marker', 'saved'); document.cookie = 'fixture=cookie-value; path=/'; render()">Save marker</button>
  <output id="marker" aria-label="Marker"></output>
  <script>
    function render() {
      document.getElementById('marker').textContent = localStorage.getItem('marker') ?? 'empty';
    }
    render();
  </script>
</body>
</html>`),
  // A canvas whose nodes have only a random test id; `?seeded` starts with one.
  '/graph': constant(`<!doctype html>
<html>
<head><title>Graph</title></head>
<body>
  <h1>Graph</h1>
  <button id="add">Add node</button>
  <p role="status" id="status">Empty canvas</p>
  <div id="canvas"></div>
  <script>
    const status = document.getElementById('status');
    function addNode() {
      const node = document.createElement('div');
      node.dataset.testid = 'rf__node-' + crypto.randomUUID();
      node.style.cssText = 'display:inline-block;width:60px;height:40px;margin:8px;background:#8ad';
      node.addEventListener('click', () => { status.textContent = 'Node selected'; });
      document.getElementById('canvas').append(node);
    }
    document.getElementById('add').addEventListener('click', () => { addNode(); status.textContent = 'Node added'; });
    if (new URLSearchParams(location.search).has('seeded')) { addNode(); status.textContent = 'One node'; }
  </script>
</body>
</html>`),
  '/verbs': constant(`<!doctype html>
<html>
<head><title>Verbs playground</title></head>
<body>
  <h1>Verbs</h1>

  <label for="search">Search</label>
  <input id="search" type="search" onkeydown="if (event.key === 'Enter') document.getElementById('submitted').textContent = 'submitted:' + this.value" />
  <output id="submitted" aria-label="Submitted"></output>

  <label for="city">City</label>
  <input id="city" autocomplete="off" />
  <output id="keys" aria-label="Keys">0</output>
  <ul id="cities" aria-label="Cities"></ul>
  <script>
    // Suggestions render on key events only: a value set without keystrokes leaves the list empty.
    const CITIES = ['Warsaw', 'Wroclaw', 'Gdansk'];
    const city = document.getElementById('city');
    let keys = 0;
    city.addEventListener('keydown', () => {
      keys += 1;
      document.getElementById('keys').textContent = String(keys);
    });
    city.addEventListener('keyup', () => {
      const typed = city.value.toLowerCase();
      const list = document.getElementById('cities');
      list.replaceChildren();
      if (typed === '') return;
      for (const name of CITIES.filter((candidate) => candidate.toLowerCase().startsWith(typed))) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
      }
    });
  </script>

  <div id="hover-zone" onmouseenter="document.getElementById('reveal').hidden = false">Hover zone</div>
  <button id="reveal" hidden>Revealed action</button>

  <ul aria-label="Board">
    <li id="card" draggable="true">Card One</li>
  </ul>
  <div id="dropzone" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.getElementById('drop-state').textContent = 'dropped'">Drop zone</div>
  <output id="drop-state" aria-label="Drop state"></output>

  <label for="avatar">Avatar</label>
  <input id="avatar" type="file" onchange="document.getElementById('file-name').textContent = this.files[0] ? this.files[0].name : ''" />
  <output id="file-name" aria-label="File name"></output>
</body>
</html>`),
  // Rich-text editors: a bare contenteditable host named through
  // aria-labelledby, and one that also carries the explicit role Playwright's
  // role selector needs to find it.
  '/editor': constant(`<!doctype html>
<html>
<head><title>Editor</title></head>
<body>
  <h1>Editor</h1>
  <span id="notes-label">Notes</span>
  <div id="notes" contenteditable aria-labelledby="notes-label" data-testid="notes"><p><br></p></div>
  <span id="message-label">Message</span>
  <div id="message" contenteditable role="textbox" aria-labelledby="message-label" data-testid="message"><p><br></p></div>
  <span id="code-label">Code</span>
  <div id="code" contenteditable style="white-space: pre-wrap" aria-labelledby="code-label" data-testid="code">  keep spaces  </div>
</body>
</html>`),
  // A plain (not password) field that selects characters 5 to 45 of whatever
  // is typed into it and keeps focus, so the observation reads a selection.
  '/select-part': constant(`<!doctype html>
<html>
<head><title>Select part</title></head>
<body>
  <label for="token">Token</label>
  <input id="token" type="text" />
  <script>
    const token = document.getElementById('token');
    token.addEventListener('input', () => token.setSelectionRange(5, 45));
  </script>
</body>
</html>`),
  '/dialog': constant(`<!doctype html>
<html>
<head><title>Dialog page</title></head>
<body>
  <h1>Dialog</h1>
  <button onclick="document.getElementById('answer').textContent = confirm('Proceed?') ? 'accepted' : 'dismissed'">Ask</button>
  <output id="answer" aria-label="Answer"></output>
</body>
</html>`),
  // The flags as a script the document waits for: a route on it is invoked
  // before the page's load event, so before the navigation returns.
  '/script-flags': constant(`<!doctype html>
<html>
<head><title>Flags</title><script src="/api/flags.js"></script></head>
<body>
  <h1>Flags</h1>
</body>
</html>`),
  '/flags': constant(`<!doctype html>
<html>
<head><title>Flags</title></head>
<body>
  <h1>Flags</h1>
  <output id="flags" aria-label="Flags">loading</output>
  <script>
    fetch('/api/flags')
      .then((response) => response.json())
      .then((flags) => {
        document.getElementById('flags').textContent = flags.betaBoard ? 'beta on' : 'beta off';
      })
      .catch(() => {
        document.getElementById('flags').textContent = 'error';
      });
  </script>
</body>
</html>`),
  // One `value` attribute on a password input, the same on a text input, and
  // a text input without one.
  '/value-attributes': constant(`<!doctype html>
<html>
<head><title>Value attributes</title></head>
<body>
  <input aria-label="Secret" type="password" value="marker-5e0c" />
  <input aria-label="Plain" type="text" value="marker-5e0c" />
  <input aria-label="Blank" type="text" />
</body>
</html>`),
  // What toHaveRole reads: roles from markup and from ARIA, and the one the
  // vocabulary spells its own way (ARIA's img is image).
  '/role-matcher': constant(`<!doctype html>
<html>
<head><title>Role matcher</title></head>
<body>
  <input aria-label="Name" />
  <input aria-label="Secret" type="password" value="marker-7c1f" />
  <button role="switch" aria-checked="true">Wi-Fi</button>
  <img data-testid="logo" alt="Logo" src="/fixture.png" />
  <h2 data-testid="title">Title</h2>
  <h1 contenteditable="true" data-testid="doc">Untitled</h1>
  <div data-testid="plain">Plain</div>
</body>
</html>`),
  // What toBeEmpty reads, as Playwright decides it: an input or textarea is
  // empty when its value is, any other element when its trimmed text content
  // is, hidden text included.
  '/empty-matcher': constant(`<!doctype html>
<html>
<head><title>Empty matcher</title></head>
<body>
  <input data-testid="blank-input" aria-label="Blank" />
  <textarea data-testid="blank-textarea" aria-label="Notes"></textarea>
  <div data-testid="blank-div">   </div>
  <div data-testid="blank-editor" contenteditable="true">   </div>
  <input data-testid="filled-input" aria-label="Filled" value="x" />
  <input data-testid="space-input" aria-label="Spaces" value="  " />
  <p data-testid="text">Some text</p>
  <div data-testid="hidden-text"><span hidden>Later</span></div>
  <input aria-label="Secret" type="password" value="marker-9d2a" />
  <script>
    // A filled input made in another frame keeps that frame's prototype here.
    const donor = document.createElement('iframe');
    donor.hidden = true;
    document.body.append(donor);
    const adopted = donor.contentDocument.createElement('input');
    adopted.setAttribute('data-testid', 'adopted-input');
    adopted.setAttribute('aria-label', 'Adopted');
    adopted.value = 'filled';
    document.body.append(adopted);
  </script>
  <button data-testid="combobox" role="combobox" aria-expanded="false">Select a fruit</button>
  <ul data-testid="listbox" role="listbox"><li role="option">Apple</li></ul>
  <div data-testid="textbox" role="textbox" contenteditable="true">hello</div>
  <div data-testid="aria-textbox" role="textbox">hello</div>
  <select data-testid="select" aria-label="Colour"><option value="">Choose a colour</option><option value="red">Red</option></select>
  <input data-testid="submit" type="submit" value="Go" />
  <input data-testid="checkbox" type="checkbox" aria-label="Agree" />
</body>
</html>`),
  // What toBeEditable reads: native readonly, aria-readonly, the disabled
  // state a fieldset gives, an editing host and what is inside it, and a role
  // that cannot be read-only. A native tag reads readonly alone, an ARIA role
  // aria-readonly alone, as Playwright's getReadonly does.
  '/editable-matcher': constant(`<!doctype html>
<html>
<head><title>Editable matcher</title></head>
<body>
  <input aria-label="Name" />
  <textarea aria-label="Notes" readonly></textarea>
  <div role="textbox" aria-label="Total" aria-readonly="true">42</div>
  <select aria-label="Size"><option>S</option><option>M</option></select>
  <select aria-label="Size locked" readonly><option>S</option></select>
  <select aria-label="Size aria" aria-readonly="true"><option>S</option></select>
  <fieldset disabled><input aria-label="Locked" /></fieldset>
  <div contenteditable="true" data-testid="editor">Draft<p data-testid="editor-line">Line</p></div>
  <input aria-label="Secret" type="password" readonly value="marker-3b9d" />
  <input aria-label="Aria on input" aria-readonly="true" />
  <div role="textbox" aria-label="Upper case" aria-readonly="TRUE">7</div>
  <input type="radio" aria-label="Pick" readonly />
  <div role="textbox" aria-label="Attribute on div" readonly>8</div>
  <div contenteditable="true" role="textbox" aria-label="Locked editor" aria-readonly="true">Fixed</div>
  <div contenteditable="true" data-testid="plain-host" aria-readonly="true">Open</div>
  <table role="grid"><tr><td contenteditable="true" data-testid="grid-cell" aria-readonly="true">5</td></tr></table>
  <button>Save</button>
</body>
</html>`),
  '/downloads': constant(
    '<!doctype html><html><head><title>Downloads</title></head><body><h1>Downloads</h1>' +
      '<a href="/report.csv" download>Download report</a></body></html>',
  ),
  // An export that carries what the form was filled with: the link downloads
  // a CSV echoing the key field, the way an app's export includes its data.
  '/exports': constant(`<!doctype html><html><head><title>Exports</title></head><body>
  <h1>Exports</h1>
  <label for="export-key">Export key</label>
  <input id="export-key" type="password" autocomplete="off" />
  <a id="export" href="/echo.csv" download>Download export</a>
  <script>
    document.getElementById('export').addEventListener('click', () => {
      const key = document.getElementById('export-key').value;
      document.getElementById('export').href = '/echo.csv?value=' + encodeURIComponent(key);
    });
  </script>
</body></html>`),
  // Echoes the Source field after filler long enough that an observation's
  // text (512) and name (256) limits cut the value's last character, next to
  // a plain value placed the same way. An editor echoes it upper-cased by CSS:
  // its value is read as rendered and cut at the text limit too.
  '/echo-cut': constant(`<!doctype html>
<html>
<head><title>Echo cut</title></head>
<body>
  <label for="source">Source</label>
  <input id="source" />
  <p id="echo"></p>
  <div id="echo-upper" contenteditable="true" aria-label="Upper echo" style="text-transform: uppercase"></div>
  <button id="echo-name">Echo</button>
  <p id="control"></p>
  <script>
    const filler = (length) => '0123456789'.repeat(60).slice(0, length);
    const echo = (value) => {
      document.getElementById('echo').textContent = filler(512 - value.length + 1) + value;
      document.getElementById('echo-upper').textContent = filler(512 - value.length + 1) + value;
      document.getElementById('echo-name').setAttribute('aria-label', filler(256 - value.length + 1) + value);
    };
    document.getElementById('source').addEventListener('input', (event) => echo(event.target.value));
    document.getElementById('control').textContent = filler(512 - 59) + 'plain-control-'.repeat(5);
  </script>
</body>
</html>`),
};
