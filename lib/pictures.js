// Pictures in Markdown: ```mermaid and ```svg fenced blocks, and local image files.
//
// Nothing here serves a file. Local images are resolved to real paths at launch and
// recorded in a registry; the server only answers for ids in that registry.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { ContractError, resolveDocumentPath } from './contract.js';

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'marker', 'pattern',
];
// Tags whose content is dropped along with the tag, not left behind as text.
const SVG_DROP_WITH_CONTENT = ['script', 'style', 'foreignObject', 'animate', 'animateTransform', 'animateMotion', 'set', 'textarea', 'option'];
const SVG_ATTRIBUTES = [
  'id', 'viewBox', 'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'd', 'points',
  'transform', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'stroke-opacity', 'fill-opacity', 'opacity', 'fill-rule', 'clip-rule', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'textLength', 'preserveAspectRatio',
  'xmlns', 'xmlns:xlink', 'version', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'fx', 'fy', 'clip-path', 'clipPathUnits', 'mask', 'maskUnits', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth',
  'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'patternUnits', 'patternTransform', 'href', 'xlink:href',
  'role', 'aria-label', 'aria-hidden', 'visibility',
];
const MAX_SVG_BYTES = 200_000;

// Per-attribute rule: a reference may only point inside the same SVG ("#id" or url(#id)).
function keepAttribute(name, value) {
  const text = String(value).trim();
  if (name === 'href' || name === 'xlink:href') return text.startsWith('#');
  if (/javascript:|data:|expression\s*\(|@import|&#|\\/i.test(text)) return false;
  for (const match of text.matchAll(/url\s*\(\s*(['"]?)\s*([^)'"]*)/gi)) {
    if (!match[2].startsWith('#')) return false;
  }
  return true;
}

export function sanitizeSvg(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SVG_BYTES) return '';
  const stripped = source.replace(/<(script|style|foreignobject)\b[\s\S]*?<\/\1\s*>/gi, '');
  const cleaned = sanitizeHtml(stripped, {
    allowedTags: SVG_TAGS,
    allowedAttributes: { '*': SVG_ATTRIBUTES },
    nonTextTags: SVG_DROP_WITH_CONTENT.flatMap((tag) => [tag, tag.toLowerCase(), tag.toUpperCase()]),
    disallowedTagsMode: 'discard',
    allowProtocolRelative: false,
    parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false, decodeEntities: true },
    transformTags: {
      '*': (tagName, attribs) => {
        const kept = {};
        for (const [name, value] of Object.entries(attribs)) if (keepAttribute(name, value)) kept[name] = value;
        return { tagName, attribs: kept };
      },
    },
  });
  return /<svg[\s>]/.test(cleaned) ? cleaned : '';
}

function fenceLanguage(token) {
  return (token.info ?? '').trim().split(/\s+/)[0].toLowerCase();
}

// ```mermaid keeps its source in the page (hidden once the browser draws the diagram, shown
// as a code block if the diagram library cannot load). ```svg is sanitised here and drawn
// next to its (hidden) source.
export function installDiagramFences(md) {
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, environment, self) => {
    const token = tokens[index];
    const language = fenceLanguage(token);
    const html = defaultFence(tokens, index, options, environment, self);
    if (!html.startsWith('<pre>')) return html;
    if (language === 'mermaid') return `<pre class="diagram-source" data-diagram="mermaid">${html.slice(5)}`;
    if (language === 'svg') {
      const svg = sanitizeSvg(token.content);
      if (!svg) return `<pre class="diagram-source" data-diagram="svg">${html.slice(5)}`;
      return `<pre class="diagram-source diagram-source-hidden" data-diagram="svg">${html.slice(5)}<figure class="diagram diagram-svg">${svg}</figure>\n`;
    }
    return html;
  };
}

function isLocalImageSource(source) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith('//') && !source.startsWith('#');
}

export function createImageRegistry() {
  return { files: new Map(), ids: new Map() };
}

// Finds every local image in a parsed token stream, checks it, records it in the registry
// and rewrites its src to the route the server answers (img/<id>).
export async function localizeImages(tokens, baseDirectory, registry) {
  for (const token of tokens) {
    if (token.type === 'image') {
      const source = token.attrGet('src') ?? '';
      if (!isLocalImageSource(source)) continue;
      let decoded;
      try { decoded = decodeURIComponent(source); } catch { decoded = source; }
      const extension = path.extname(decoded).toLowerCase();
      const type = IMAGE_TYPES[extension];
      if (!type) throw new ContractError(`Image ${source} is not a supported image file (png, jpg, jpeg, gif, webp, svg).`);
      if (path.isAbsolute(decoded)) throw new ContractError(`Image path ${source} must be relative.`);
      const resolved = await resolveDocumentPath(baseDirectory, decoded).catch((error) => {
        throw new ContractError(`Cannot use image ${source}: ${error.message}`);
      });
      const real = await realpath(resolved);
      if (!registry.ids.has(real)) {
        const id = `${registry.ids.size}${extension}`;
        registry.ids.set(real, id);
        registry.files.set(id, { path: real, type });
      }
      token.attrSet('src', `img/${registry.ids.get(real)}`);
    }
    if (token.children?.length) await localizeImages(token.children, baseDirectory, registry);
  }
}
