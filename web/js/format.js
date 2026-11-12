// Formatting and small DOM helpers shared by the page's modules.

export const $ = (selector, root = document) => root.querySelector(selector);

export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'style') {
      for (const [property, setting] of Object.entries(value)) {
        if (property.startsWith('--')) node.style.setProperty(property, setting);
        else node.style[property] = setting;
      }
    } else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// Probabilities round down, so a reading the network is nearly sure of never shows as 100%.
export function percent(probability, decimals = 1) {
  const scale = 10 ** decimals;
  return `${(Math.floor(100 * probability * scale + 1e-9) / scale).toFixed(decimals)}%`;
}

export function milliseconds(value) {
  if (value >= 100) return `${Math.round(value)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

export function bytes(count) {
  return count >= 1e6 ? `${(count / 1e6).toFixed(1)} MB` : `${Math.round(count / 1e3)} KB`;
}

export function clock(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// How sure a probability is, as the colors show it: green from 0.9, amber from 0.6, red below.
export function sureness(probability) {
  if (probability >= 0.9) return 'high';
  if (probability >= 0.6) return 'mid';
  return 'low';
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const container = $('#toasts');
  const node = element('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  container.replaceChildren(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3200);
}
