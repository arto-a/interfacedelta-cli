import { describe, expect, it } from 'vitest';
import { WEBMCP_SPECIFICATION } from '@interfacedelta/contracts';
import {
  WEBMCP_LIMITS,
  extractWebMcpDeclarativeTools,
  webMcpNotObserved,
} from './webmcp-html';

const url = new URL('https://shop.example/');
const extract = (html: string, documentUrl = url) =>
  extractWebMcpDeclarativeTools(html, documentUrl, 'https://shop.example/');

// Verbatim from declarative-api-explainer.md at webmcp@f5645e9.
const SPEC_SEARCH_CARS = `<form toolname="search-cars" tooldescription="Perform a car make/model search" [...]>
 <input type=text name="make" toolparamdescription="The vehicle's make (i.e., BMW, Ford)" required>
 <input type=text name="model" toolparamdescription="The vehicle's model (i.e., 330i, F-150)" required>
 <button type=submit>Search</button>
</form>`;
const SPEC_FLIGHTS = `<form
  toolname="Search flights"
  tooldescription="This form searches flights and displays [...]"
  toolautosubmit>`;

describe('WebMCP declarative tool detection', () => {
  it('caps text by code point and never leaves a lone surrogate or half escape', () => {
    const name = `${'a'.repeat(WEBMCP_LIMITS.nameLength - 1)}😀😀`;
    const path = `/${'x'.repeat(WEBMCP_LIMITS.urlLength - 'https://shop.example/'.length - 1)}%C3%A9`;
    const [tool] = extract(
      `<form toolname="${name}" action="${path}"></form>`,
    ).tools;
    expect(Array.from(tool!.name)).toHaveLength(WEBMCP_LIMITS.nameLength);
    expect(tool!.name.endsWith('😀')).toBe(true);
    expect(tool!.name).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
    expect(tool!.action).not.toMatch(/%[0-9A-Fa-f]?$/);
    expect(tool!.action!.length).toBeLessThanOrEqual(WEBMCP_LIMITS.urlLength);
  });
  it('drops bidi controls from names and descriptions, and nothing else', () => {
    const bidi = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
    const spoofed = extract(
      `<form toolname="delete\u202e_resu" tooldescription="\u2067Safe\u2069 tool\u200f"><input name="\u202aid\u202c" toolparamdescription="\u061cthe id"></form>`,
    );
    const plain = extract(
      '<form toolname="delete_resu" tooldescription="Safe tool"><input name="id" toolparamdescription="the id"></form>',
    );
    expect(spoofed).toEqual(plain);
    expect(JSON.stringify(spoofed)).not.toMatch(bidi);
    // Right-to-left text and emoji joiners are content, not controls.
    const [tool] = extract(
      '<form toolname="חיפוש" tooldescription="👩\u200d💻 بحث"></form>',
    ).tools;
    expect(tool!.name).toBe('חיפוש');
    expect(tool!.description).toBe('👩\u200d💻 بحث');
  });
  it('records the specification example form with its declared controls', () => {
    const observed = extract(SPEC_SEARCH_CARS);
    expect(observed).toMatchObject({
      status: 'observed',
      scope: 'root_html_declarative_forms',
      specification: WEBMCP_SPECIFICATION,
      toolCount: 1,
      toolsTruncated: false,
      unnamedDeclarations: 0,
      warnings: [],
    });
    expect(observed.tools).toEqual([
      {
        name: 'search-cars',
        description: 'Perform a car make/model search',
        autoSubmit: false,
        method: 'get',
        action: 'https://shop.example/',
        actionRelationship: 'same_origin',
        controls: [
          {
            name: 'make',
            element: 'input',
            type: 'text',
            required: true,
            description: "The vehicle's make (i.e., BMW, Ford)",
            occurrences: 1,
          },
          {
            name: 'model',
            element: 'input',
            type: 'text',
            required: true,
            description: "The vehicle's model (i.e., 330i, F-150)",
            occurrences: 1,
          },
        ],
        controlCount: 2,
        controlsTruncated: false,
      },
    ]);
  });

  it('reads toolautosubmit as a boolean attribute from the specification example', () => {
    const [tool] = extract(`${SPEC_FLIGHTS}</form>`).tools;
    expect(tool).toMatchObject({
      name: 'Search flights',
      description: 'This form searches flights and displays [...]',
      autoSubmit: true,
    });
  });

  it('keeps multiple forms distinct and classifies actions without following them', () => {
    const observed = extract(`
      <form toolname="local" method="POST" action="/checkout"></form>
      <form toolname="remote" action="https://payments.example/pay"></form>
      <form toolname="script" action="javascript:alert(1)"></form>
      <form toolname="modal" method="dialog" action="https://ignored.example/"></form>
      <form toolname="broken" action="https://[bad"></form>
      <form action="/ordinary"><input name="q"></form>`);
    expect(
      observed.tools.map((tool) => [
        tool.name,
        tool.method,
        tool.actionRelationship,
        tool.action,
      ]),
    ).toEqual([
      ['local', 'post', 'same_origin', 'https://shop.example/checkout'],
      ['remote', 'get', 'cross_origin', 'https://payments.example/pay'],
      ['script', 'get', 'non_http', undefined],
      ['modal', 'dialog', 'not_applicable', undefined],
      ['broken', 'get', 'unresolvable', undefined],
    ]);
    expect(observed.toolCount).toBe(5);
  });

  it('counts forms that carry tool attributes without a usable name', () => {
    const observed = extract(`
      <form tooldescription="no name"></form>
      <form toolname="   " toolautosubmit></form>
      <form toolname="named"></form>`);
    expect(observed.tools.map((tool) => tool.name)).toEqual(['named']);
    expect(observed.unnamedDeclarations).toBe(2);
  });

  it('bounds and sanitizes oversize or control-character values', () => {
    const observed = extract(
      `<form toolname="${'n'.repeat(500)}" tooldescription="a\u0000b\u0085c${'d'.repeat(5_000)}">
        <input name="x" toolparamdescription="${'p'.repeat(2_000)}" type="${'t'.repeat(100)}">
      </form>`,
    );
    const [tool] = observed.tools;
    expect(tool!.name).toHaveLength(WEBMCP_LIMITS.nameLength);
    expect(tool!.description).toHaveLength(WEBMCP_LIMITS.descriptionLength);
    expect(tool!.description!.startsWith('abcd')).toBe(true);
    expect(tool!.controls[0]!.description).toHaveLength(
      WEBMCP_LIMITS.controlDescriptionLength,
    );
    expect(tool!.controls[0]!.type).toHaveLength(WEBMCP_LIMITS.typeLength);
  });

  it('truncates tool and control lists at their bounds and says so', () => {
    const many = Array.from(
      { length: WEBMCP_LIMITS.maxTools + 3 },
      (_, index) => `<form toolname="t${index}"></form>`,
    ).join('');
    const tools = extract(many);
    expect(tools.tools).toHaveLength(WEBMCP_LIMITS.maxTools);
    expect(tools).toMatchObject({
      toolCount: WEBMCP_LIMITS.maxTools + 3,
      toolsTruncated: true,
    });
    const inputs = Array.from(
      { length: WEBMCP_LIMITS.maxControlsPerTool + 1 },
      (_, index) => `<input name="f${index}">`,
    ).join('');
    const [tool] = extract(`<form toolname="wide">${inputs}</form>`).tools;
    expect(tool!.controls).toHaveLength(WEBMCP_LIMITS.maxControlsPerTool);
    expect(tool).toMatchObject({
      controlCount: WEBMCP_LIMITS.maxControlsPerTool + 1,
      controlsTruncated: true,
    });
  });

  it('reports no declarative tools without claiming the site has none', () => {
    const observed = extract(
      '<html><body><form action="/search"><input name="q"></form><script>document.modelContext.registerTool({name:"x"})</script></body></html>',
    );
    expect(observed).toMatchObject({
      status: 'none_observed',
      tools: [],
      toolCount: 0,
      unnamedDeclarations: 0,
    });
  });

  it('ignores template and noscript contents, as a scripting browser would', () => {
    expect(
      extract(
        '<template><form toolname="hidden"></form></template><noscript><form toolname="fallback"></form></noscript>',
      ).status,
    ).toBe('none_observed');
  });

  it('associates controls through the form attribute, select options and radio groups', () => {
    const [tool] = extract(`
      <form id="order" toolname="order"></form>
      <input name="qty" form="order" required>
      <input name="stray" form="missing">
      <select name="size" form="order"><option>S</option><optgroup><option>M</option><option>L</option></optgroup></select>
      <form toolname="other"><input type="radio" name="speed" value="a"><input type="radio" name="speed" value="b" required></form>
    `).tools;
    expect(tool!.controls).toEqual([
      { name: 'qty', element: 'input', required: true, occurrences: 1 },
      {
        name: 'size',
        element: 'select',
        required: false,
        optionCount: 3,
        occurrences: 1,
      },
    ]);
    const other = extract(
      '<form toolname="other"><input type="radio" name="speed" value="a"><input type="radio" name="speed" value="b" required></form>',
    ).tools[0]!;
    expect(other.controls).toEqual([
      {
        name: 'speed',
        element: 'input',
        type: 'radio',
        required: true,
        occurrences: 2,
      },
    ]);
  });

  it('does not treat a non-form element as the form attribute target', () => {
    const [tool] = extract(
      '<div id="order"></div><form id="order" toolname="order"></form><input name="qty" form="order">',
    ).tools;
    expect(tool!.controls).toEqual([]);
  });

  it('resolves actions against a document base URL and flags duplicate names', () => {
    const observed = extract(
      '<base href="https://cdn.example/app/"><form toolname="dup" action="go"></form><form toolname="dup"></form>',
    );
    expect(observed.tools[0]).toMatchObject({
      action: 'https://cdn.example/app/go',
      actionRelationship: 'cross_origin',
    });
    expect(observed.warnings).toEqual(['DUPLICATE_TOOL_NAME']);
  });

  it('builds an explicit not-observed result for unusable root responses', () => {
    expect(
      webMcpNotObserved('https://shop.example/', 'response_too_large'),
    ).toMatchObject({
      status: 'not_observed',
      reason: 'response_too_large',
      tools: [],
    });
  });
});
