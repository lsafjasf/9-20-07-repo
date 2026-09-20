'use strict';
(function (global) {
  const GV = global.GV || (global.GV = {});

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k]);
        } else if (attrs[k] !== false && attrs[k] != null) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function shortId(id) {
    return id ? String(id).slice(0, 7) : '';
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function filesEqual(a, b) {
    const ka = Object.keys(a || {}).sort();
    const kb = Object.keys(b || {}).sort();
    if (ka.length !== kb.length) return false;
    return ka.every(function (k, i) { return k === kb[i] && a[k] === b[k]; });
  }

  function nowStamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  class GitError extends Error {
    constructor(message, conflicts) {
      super(message);
      this.name = 'GitError';
      this.conflicts = conflicts || null;
    }
  }

  GV.esc = esc;
  GV.el = el;
  GV.svgEl = svgEl;
  GV.shortId = shortId;
  GV.clone = clone;
  GV.filesEqual = filesEqual;
  GV.nowStamp = nowStamp;
  GV.GitError = GitError;
})(window);
