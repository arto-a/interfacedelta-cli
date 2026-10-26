import { Parser } from 'htmlparser2';
import { stripBidiControls } from '@interfacedelta/common/display-text';
import {
  WEBMCP_OBSERVATION_VERSION,
  WEBMCP_SPECIFICATION,
  type WebMcpDeclarativeTool,
  type WebMcpDeclaredControl,
  type WebMcpPageScan,
} from '@interfacedelta/contracts';

type Scope = WebMcpPageScan['scope'];
const ROOT_SCOPE = 'root_html_declarative_forms' as const;

export const WEBMCP_LIMITS = {
  maxTools: 32,
  maxControlsPerTool: 64,
  nameLength: 200,
  descriptionLength: 1_000,
  controlDescriptionLength: 500,
  typeLength: 40,
  urlLength: 2_000,
} as const;

const CONTROL_ELEMENTS = new Set(['input', 'select', 'textarea', 'button']);

const clean = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  // C0, C1 and bidi controls are dropped; bidi could reorder a displayed name.
  const printable = [...stripBidiControls(value)]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code > 31 || code === 9 || code === 10 || code === 13) &&
        (code < 127 || code > 159)
      );
    })
    .join('')
    .trim();
  // Slice by code point so a cap never leaves a lone surrogate.
  return printable ? Array.from(printable).slice(0, max).join('') : undefined;
};

type RawControl = {
  name: string;
  element: WebMcpDeclaredControl['element'];
  type?: string;
  required: boolean;
  description?: string;
  optionCount?: number;
  formAttribute?: string;
  ancestorForm?: RawForm;
};
type RawForm = {
  toolName?: string;
  toolDescription?: string;
  hasToolAttributes: boolean;
  autoSubmit: boolean;
  method: WebMcpDeclarativeTool['method'];
  action?: string;
};

const method = (value: string | undefined): WebMcpDeclarativeTool['method'] => {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'post' || normalized === 'dialog' ? normalized : 'get';
};

function resolveAction(
  form: RawForm,
  documentUrl: URL,
  baseUrl: URL,
): Pick<WebMcpDeclarativeTool, 'action' | 'actionRelationship'> {
  if (form.method === 'dialog') return { actionRelationship: 'not_applicable' };
  const raw = form.action?.trim();
  let target: URL;
  try {
    target = raw ? new URL(raw, baseUrl) : documentUrl;
  } catch {
    return { actionRelationship: 'unresolvable' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:')
    return { actionRelationship: 'non_http' };
  return {
    // href is ASCII; drop a percent-escape the cap would cut in half.
    action: target.href
      .slice(0, WEBMCP_LIMITS.urlLength)
      .replace(/%[0-9A-Fa-f]?$/, ''),
    actionRelationship:
      target.origin === documentUrl.origin ? 'same_origin' : 'cross_origin',
  };
}

function groupControls(controls: RawControl[]): WebMcpDeclaredControl[] {
  const grouped = new Map<string, WebMcpDeclaredControl>();
  for (const control of controls) {
    const key = JSON.stringify([control.name, control.element, control.type]);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        name: control.name,
        element: control.element,
        ...(control.type ? { type: control.type } : {}),
        required: control.required,
        ...(control.description ? { description: control.description } : {}),
        ...(control.optionCount !== undefined
          ? { optionCount: control.optionCount }
          : {}),
        occurrences: 1,
      });
      continue;
    }
    grouped.set(key, {
      ...existing,
      required: existing.required || control.required,
      ...(!existing.description && control.description
        ? { description: control.description }
        : {}),
      occurrences: existing.occurrences + 1,
    });
  }
  return [...grouped.values()];
}

/**
 * Recognizes declarative WebMCP form tools in already-retrieved HTML. Scripts
 * never run, so tools registered through `document.modelContext` are not
 * visible here, and absence is never evidence that a site has no WebMCP tools.
 */
export function extractWebMcpDeclarativeTools<
  S extends Scope = typeof ROOT_SCOPE,
>(
  html: string,
  documentUrl: URL,
  sourceUrl: string,
  scope: S = ROOT_SCOPE as S,
): WebMcpPageScan & { readonly scope: S } {
  const forms: RawForm[] = [];
  const controls: RawControl[] = [];
  const firstElementById = new Map<string, RawForm | null>();
  let baseHref: string | undefined;
  let currentForm: RawForm | undefined;
  let currentSelect: RawControl | undefined;
  // Template contents are not in the document, and a script-enabled browser
  // (which WebMCP requires) treats noscript contents as text.
  let inertDepth = 0;
  let foreignDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === 'template' || name === 'noscript') {
          inertDepth++;
          return;
        }
        if (inertDepth) return;
        const id = attributes.id;
        if (name === 'svg' || name === 'math') foreignDepth++;
        if (foreignDepth) {
          if (id !== undefined && !firstElementById.has(id))
            firstElementById.set(id, null);
          return;
        }
        if (
          name === 'base' &&
          baseHref === undefined &&
          attributes.href !== undefined
        )
          baseHref = attributes.href;
        if (name === 'form') {
          const toolName = clean(attributes.toolname, WEBMCP_LIMITS.nameLength);
          const form: RawForm = {
            toolName,
            toolDescription: clean(
              attributes.tooldescription,
              WEBMCP_LIMITS.descriptionLength,
            ),
            hasToolAttributes:
              'toolname' in attributes ||
              'tooldescription' in attributes ||
              'toolautosubmit' in attributes,
            autoSubmit: 'toolautosubmit' in attributes,
            method: method(attributes.method),
            action: attributes.action,
          };
          forms.push(form);
          currentForm = form;
          if (id !== undefined && !firstElementById.has(id))
            firstElementById.set(id, form);
          return;
        }
        if (id !== undefined && !firstElementById.has(id))
          firstElementById.set(id, null);
        if (name === 'option' && currentSelect) {
          currentSelect.optionCount = (currentSelect.optionCount ?? 0) + 1;
          return;
        }
        if (!CONTROL_ELEMENTS.has(name)) return;
        const controlName = clean(attributes.name, WEBMCP_LIMITS.nameLength);
        const control: RawControl = {
          name: controlName ?? '',
          element: name as RawControl['element'],
          type: clean(attributes.type, WEBMCP_LIMITS.typeLength)?.toLowerCase(),
          required: 'required' in attributes,
          description: clean(
            attributes.toolparamdescription,
            WEBMCP_LIMITS.controlDescriptionLength,
          ),
          ...(name === 'select' ? { optionCount: 0 } : {}),
          formAttribute: attributes.form,
          ancestorForm: currentForm,
        };
        if (name === 'select') currentSelect = control;
        if (controlName) controls.push(control);
      },
      onclosetag(name) {
        if (name === 'template' || name === 'noscript') {
          inertDepth = Math.max(0, inertDepth - 1);
          return;
        }
        if (inertDepth) return;
        if (name === 'svg' || name === 'math') {
          foreignDepth = Math.max(0, foreignDepth - 1);
          return;
        }
        if (foreignDepth) return;
        if (name === 'form') currentForm = undefined;
        if (name === 'select') currentSelect = undefined;
      },
    },
    {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: false,
    },
  );
  parser.end(html);

  let baseUrl = documentUrl;
  if (baseHref !== undefined)
    try {
      const candidate = new URL(baseHref, documentUrl);
      if (candidate.protocol === 'https:' || candidate.protocol === 'http:')
        baseUrl = candidate;
    } catch {
      /* an unparsable base leaves the document URL as the base */
    }

  const owned = new Map<RawForm, RawControl[]>();
  for (const control of controls) {
    const owner =
      control.formAttribute !== undefined
        ? (firstElementById.get(control.formAttribute) ?? undefined)
        : control.ancestorForm;
    if (!owner) continue;
    owned.set(owner, [...(owned.get(owner) ?? []), control]);
  }

  const declared = forms.filter((form) => form.toolName);
  const unnamedDeclarations = forms.filter(
    (form) => form.hasToolAttributes && !form.toolName,
  ).length;
  const tools = declared.slice(0, WEBMCP_LIMITS.maxTools).map((form) => {
    const grouped = groupControls(owned.get(form) ?? []);
    return {
      name: form.toolName!,
      ...(form.toolDescription ? { description: form.toolDescription } : {}),
      autoSubmit: form.autoSubmit,
      method: form.method,
      ...resolveAction(form, documentUrl, baseUrl),
      controls: grouped.slice(0, WEBMCP_LIMITS.maxControlsPerTool),
      controlCount: grouped.length,
      controlsTruncated: grouped.length > WEBMCP_LIMITS.maxControlsPerTool,
    } satisfies WebMcpDeclarativeTool;
  });
  const names = declared.map((form) => form.toolName!);
  return {
    observationVersion: WEBMCP_OBSERVATION_VERSION,
    specification: WEBMCP_SPECIFICATION,
    scope,
    sourceUrl,
    finalUrl: documentUrl.href,
    status: declared.length ? 'observed' : 'none_observed',
    tools,
    toolCount: declared.length,
    toolsTruncated: declared.length > WEBMCP_LIMITS.maxTools,
    unnamedDeclarations,
    warnings: new Set(names).size < names.length ? ['DUPLICATE_TOOL_NAME'] : [],
  };
}

export function webMcpNotObserved<S extends Scope = typeof ROOT_SCOPE>(
  sourceUrl: string,
  reason: NonNullable<WebMcpPageScan['reason']>,
  finalUrl?: string,
  scope: S = ROOT_SCOPE as S,
): WebMcpPageScan & { readonly scope: S } {
  return {
    observationVersion: WEBMCP_OBSERVATION_VERSION,
    specification: WEBMCP_SPECIFICATION,
    scope,
    sourceUrl,
    ...(finalUrl ? { finalUrl } : {}),
    status: 'not_observed',
    reason,
    tools: [],
    toolCount: 0,
    toolsTruncated: false,
    unnamedDeclarations: 0,
    warnings: [],
  };
}
