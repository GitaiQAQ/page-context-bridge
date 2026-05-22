import { i as BRIDGE_METHODS, n as sendRuntimeRequest } from '../runtime-rpc.hjw2lJPe.js';
import { l as tabsQuery, n as runtimeGetUrl, s as tabsCreate } from '../extension-api.BMHS3pcA.js';
import {
  i as readSidepanelSurface,
  r as consumeLaunchUrlForSurface,
} from '../sidepanel-launch-state.BKy_bs2K.js';
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/css-tag.js
/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var t$3 = globalThis,
  e$6 =
    t$3.ShadowRoot &&
    (void 0 === t$3.ShadyCSS || t$3.ShadyCSS.nativeShadow) &&
    'adoptedStyleSheets' in Document.prototype &&
    'replace' in CSSStyleSheet.prototype,
  s$2 = Symbol(),
  o$4 = /* @__PURE__ */ new WeakMap();
var n$4 = class {
  constructor(t, e, o) {
    if (((this._$cssResult$ = !0), o !== s$2))
      throw Error('CSSResult is not constructable. Use `unsafeCSS` or `css` instead.');
    ((this.cssText = t), (this.t = e));
  }
  get styleSheet() {
    let t = this.o;
    const s = this.t;
    if (e$6 && void 0 === t) {
      const e = void 0 !== s && 1 === s.length;
      (e && (t = o$4.get(s)),
        void 0 === t &&
          ((this.o = t = new CSSStyleSheet()).replaceSync(this.cssText), e && o$4.set(s, t)));
    }
    return t;
  }
  toString() {
    return this.cssText;
  }
};
var r$4 = (t) => new n$4('string' == typeof t ? t : t + '', void 0, s$2),
  i$4 = (t, ...e) => {
    return new n$4(
      1 === t.length
        ? t[0]
        : e.reduce(
            (e, s, o) =>
              e +
              ((t) => {
                if (!0 === t._$cssResult$) return t.cssText;
                if ('number' == typeof t) return t;
                throw Error(
                  "Value passed to 'css' function must be a 'css' function result: " +
                    t +
                    ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.",
                );
              })(s) +
              t[o + 1],
            t[0],
          ),
      t,
      s$2,
    );
  },
  S$1 = (s, o) => {
    if (e$6) s.adoptedStyleSheets = o.map((t) => (t instanceof CSSStyleSheet ? t : t.styleSheet));
    else
      for (const e of o) {
        const o = document.createElement('style'),
          n = t$3.litNonce;
        (void 0 !== n && o.setAttribute('nonce', n), (o.textContent = e.cssText), s.appendChild(o));
      }
  },
  c$2 = e$6
    ? (t) => t
    : (t) =>
        t instanceof CSSStyleSheet
          ? ((t) => {
              let e = '';
              for (const s of t.cssRules) e += s.cssText;
              return r$4(e);
            })(t)
          : t;
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/reactive-element.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ var {
    is: i$3,
    defineProperty: e$5,
    getOwnPropertyDescriptor: h$1,
    getOwnPropertyNames: r$3,
    getOwnPropertySymbols: o$3,
    getPrototypeOf: n$3,
  } = Object,
  a$1 = globalThis,
  c$1 = a$1.trustedTypes,
  l$1 = c$1 ? c$1.emptyScript : '',
  p$1 = a$1.reactiveElementPolyfillSupport,
  d$1 = (t, s) => t,
  u$1 = {
    toAttribute(t, s) {
      switch (s) {
        case Boolean:
          t = t ? l$1 : null;
          break;
        case Object:
        case Array:
          t = null == t ? t : JSON.stringify(t);
      }
      return t;
    },
    fromAttribute(t, s) {
      let i = t;
      switch (s) {
        case Boolean:
          i = null !== t;
          break;
        case Number:
          i = null === t ? null : Number(t);
          break;
        case Object:
        case Array:
          try {
            i = JSON.parse(t);
          } catch (t) {
            i = null;
          }
      }
      return i;
    },
  },
  f$1 = (t, s) => !i$3(t, s),
  b$1 = {
    attribute: !0,
    type: String,
    converter: u$1,
    reflect: !1,
    useDefault: !1,
    hasChanged: f$1,
  };
((Symbol.metadata ??= Symbol('metadata')),
  (a$1.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap()));
var y$1 = class extends HTMLElement {
  static addInitializer(t) {
    (this._$Ei(), (this.l ??= []).push(t));
  }
  static get observedAttributes() {
    return (this.finalize(), this._$Eh && [...this._$Eh.keys()]);
  }
  static createProperty(t, s = b$1) {
    if (
      (s.state && (s.attribute = !1),
      this._$Ei(),
      this.prototype.hasOwnProperty(t) && ((s = Object.create(s)).wrapped = !0),
      this.elementProperties.set(t, s),
      !s.noAccessor)
    ) {
      const i = Symbol(),
        h = this.getPropertyDescriptor(t, i, s);
      void 0 !== h && e$5(this.prototype, t, h);
    }
  }
  static getPropertyDescriptor(t, s, i) {
    const { get: e, set: r } = h$1(this.prototype, t) ?? {
      get() {
        return this[s];
      },
      set(t) {
        this[s] = t;
      },
    };
    return {
      get: e,
      set(s) {
        const h = e?.call(this);
        (r?.call(this, s), this.requestUpdate(t, h, i));
      },
      configurable: !0,
      enumerable: !0,
    };
  }
  static getPropertyOptions(t) {
    return this.elementProperties.get(t) ?? b$1;
  }
  static _$Ei() {
    if (this.hasOwnProperty(d$1('elementProperties'))) return;
    const t = n$3(this);
    (t.finalize(),
      void 0 !== t.l && (this.l = [...t.l]),
      (this.elementProperties = new Map(t.elementProperties)));
  }
  static finalize() {
    if (this.hasOwnProperty(d$1('finalized'))) return;
    if (((this.finalized = !0), this._$Ei(), this.hasOwnProperty(d$1('properties')))) {
      const t = this.properties,
        s = [...r$3(t), ...o$3(t)];
      for (const i of s) this.createProperty(i, t[i]);
    }
    const t = this[Symbol.metadata];
    if (null !== t) {
      const s = litPropertyMetadata.get(t);
      if (void 0 !== s) for (const [t, i] of s) this.elementProperties.set(t, i);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t, s] of this.elementProperties) {
      const i = this._$Eu(t, s);
      void 0 !== i && this._$Eh.set(i, t);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(s) {
    const i = [];
    if (Array.isArray(s)) {
      const e = new Set(s.flat(Infinity).reverse());
      for (const s of e) i.unshift(c$2(s));
    } else void 0 !== s && i.push(c$2(s));
    return i;
  }
  static _$Eu(t, s) {
    const i = s.attribute;
    return !1 === i
      ? void 0
      : 'string' == typeof i
        ? i
        : 'string' == typeof t
          ? t.toLowerCase()
          : void 0;
  }
  constructor() {
    (super(),
      (this._$Ep = void 0),
      (this.isUpdatePending = !1),
      (this.hasUpdated = !1),
      (this._$Em = null),
      this._$Ev());
  }
  _$Ev() {
    ((this._$ES = new Promise((t) => (this.enableUpdating = t))),
      (this._$AL = /* @__PURE__ */ new Map()),
      this._$E_(),
      this.requestUpdate(),
      this.constructor.l?.forEach((t) => t(this)));
  }
  addController(t) {
    ((this._$EO ??= /* @__PURE__ */ new Set()).add(t),
      void 0 !== this.renderRoot && this.isConnected && t.hostConnected?.());
  }
  removeController(t) {
    this._$EO?.delete(t);
  }
  _$E_() {
    const t = /* @__PURE__ */ new Map(),
      s = this.constructor.elementProperties;
    for (const i of s.keys()) this.hasOwnProperty(i) && (t.set(i, this[i]), delete this[i]);
    t.size > 0 && (this._$Ep = t);
  }
  createRenderRoot() {
    const t = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return (S$1(t, this.constructor.elementStyles), t);
  }
  connectedCallback() {
    ((this.renderRoot ??= this.createRenderRoot()),
      this.enableUpdating(!0),
      this._$EO?.forEach((t) => t.hostConnected?.()));
  }
  enableUpdating(t) {}
  disconnectedCallback() {
    this._$EO?.forEach((t) => t.hostDisconnected?.());
  }
  attributeChangedCallback(t, s, i) {
    this._$AK(t, i);
  }
  _$ET(t, s) {
    const i = this.constructor.elementProperties.get(t),
      e = this.constructor._$Eu(t, i);
    if (void 0 !== e && !0 === i.reflect) {
      const h = (void 0 !== i.converter?.toAttribute ? i.converter : u$1).toAttribute(s, i.type);
      ((this._$Em = t),
        null == h ? this.removeAttribute(e) : this.setAttribute(e, h),
        (this._$Em = null));
    }
  }
  _$AK(t, s) {
    const i = this.constructor,
      e = i._$Eh.get(t);
    if (void 0 !== e && this._$Em !== e) {
      const t = i.getPropertyOptions(e),
        h =
          'function' == typeof t.converter
            ? { fromAttribute: t.converter }
            : void 0 !== t.converter?.fromAttribute
              ? t.converter
              : u$1;
      this._$Em = e;
      const r = h.fromAttribute(s, t.type);
      ((this[e] = r ?? this._$Ej?.get(e) ?? r), (this._$Em = null));
    }
  }
  requestUpdate(t, s, i, e = !1, h) {
    if (void 0 !== t) {
      const r = this.constructor;
      if (
        (!1 === e && (h = this[t]),
        (i ??= r.getPropertyOptions(t)),
        !(
          (i.hasChanged ?? f$1)(h, s) ||
          (i.useDefault && i.reflect && h === this._$Ej?.get(t) && !this.hasAttribute(r._$Eu(t, i)))
        ))
      )
        return;
      this.C(t, s, i);
    }
    !1 === this.isUpdatePending && (this._$ES = this._$EP());
  }
  C(t, s, { useDefault: i, reflect: e, wrapped: h }, r) {
    (i &&
      !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t) &&
      (this._$Ej.set(t, r ?? s ?? this[t]), !0 !== h || void 0 !== r)) ||
      (this._$AL.has(t) || (this.hasUpdated || i || (s = void 0), this._$AL.set(t, s)),
      !0 === e && this._$Em !== t && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t));
  }
  async _$EP() {
    this.isUpdatePending = !0;
    try {
      await this._$ES;
    } catch (t) {
      Promise.reject(t);
    }
    const t = this.scheduleUpdate();
    return (null != t && (await t), !this.isUpdatePending);
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (((this.renderRoot ??= this.createRenderRoot()), this._$Ep)) {
        for (const [t, s] of this._$Ep) this[t] = s;
        this._$Ep = void 0;
      }
      const t = this.constructor.elementProperties;
      if (t.size > 0)
        for (const [s, i] of t) {
          const { wrapped: t } = i,
            e = this[s];
          !0 !== t || this._$AL.has(s) || void 0 === e || this.C(s, void 0, i, e);
        }
    }
    let t = !1;
    const s = this._$AL;
    try {
      ((t = this.shouldUpdate(s)),
        t
          ? (this.willUpdate(s), this._$EO?.forEach((t) => t.hostUpdate?.()), this.update(s))
          : this._$EM());
    } catch (s) {
      throw ((t = !1), this._$EM(), s);
    }
    t && this._$AE(s);
  }
  willUpdate(t) {}
  _$AE(t) {
    (this._$EO?.forEach((t) => t.hostUpdated?.()),
      this.hasUpdated || ((this.hasUpdated = !0), this.firstUpdated(t)),
      this.updated(t));
  }
  _$EM() {
    ((this._$AL = /* @__PURE__ */ new Map()), (this.isUpdatePending = !1));
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(t) {
    return !0;
  }
  update(t) {
    ((this._$Eq &&= this._$Eq.forEach((t) => this._$ET(t, this[t]))), this._$EM());
  }
  updated(t) {}
  firstUpdated(t) {}
};
((y$1.elementStyles = []),
  (y$1.shadowRootOptions = { mode: 'open' }),
  (y$1[d$1('elementProperties')] = /* @__PURE__ */ new Map()),
  (y$1[d$1('finalized')] = /* @__PURE__ */ new Map()),
  p$1?.({ ReactiveElement: y$1 }),
  (a$1.reactiveElementVersions ??= []).push('2.1.2'));
//#endregion
//#region ../../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/lit-html.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var t$2 = globalThis,
  i$2 = (t) => t,
  s$1 = t$2.trustedTypes,
  e$4 = s$1 ? s$1.createPolicy('lit-html', { createHTML: (t) => t }) : void 0,
  h = '$lit$',
  o$2 = `lit$${Math.random().toFixed(9).slice(2)}$`,
  n$2 = '?' + o$2,
  r$2 = `<${n$2}>`,
  l = document,
  c = () => l.createComment(''),
  a = (t) => null === t || ('object' != typeof t && 'function' != typeof t),
  u = Array.isArray,
  d = (t) => u(t) || 'function' == typeof t?.[Symbol.iterator],
  f = '[ 	\n\f\r]',
  v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,
  _ = /-->/g,
  m = />/g,
  p = RegExp(`>|${f}(?:([^\\s"'>=/]+)(${f}*=${f}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`, 'g'),
  g = /'/g,
  $ = /"/g,
  y = /^(?:script|style|textarea|title)$/i,
  x =
    (t) =>
    (i, ...s) => ({
      _$litType$: t,
      strings: i,
      values: s,
    }),
  b = x(1);
x(2);
x(3);
var E = Symbol.for('lit-noChange'),
  A = Symbol.for('lit-nothing'),
  C = /* @__PURE__ */ new WeakMap(),
  P = l.createTreeWalker(l, 129);
function V(t, i) {
  if (!u(t) || !t.hasOwnProperty('raw')) throw Error('invalid template strings array');
  return void 0 !== e$4 ? e$4.createHTML(i) : i;
}
var N = (t, i) => {
  const s = t.length - 1,
    e = [];
  let n,
    l = 2 === i ? '<svg>' : 3 === i ? '<math>' : '',
    c = v;
  for (let i = 0; i < s; i++) {
    const s = t[i];
    let a,
      u,
      d = -1,
      f = 0;
    for (; f < s.length && ((c.lastIndex = f), (u = c.exec(s)), null !== u); )
      ((f = c.lastIndex),
        c === v
          ? '!--' === u[1]
            ? (c = _)
            : void 0 !== u[1]
              ? (c = m)
              : void 0 !== u[2]
                ? (y.test(u[2]) && (n = RegExp('</' + u[2], 'g')), (c = p))
                : void 0 !== u[3] && (c = p)
          : c === p
            ? '>' === u[0]
              ? ((c = n ?? v), (d = -1))
              : void 0 === u[1]
                ? (d = -2)
                : ((d = c.lastIndex - u[2].length),
                  (a = u[1]),
                  (c = void 0 === u[3] ? p : '"' === u[3] ? $ : g))
            : c === $ || c === g
              ? (c = p)
              : c === _ || c === m
                ? (c = v)
                : ((c = p), (n = void 0)));
    const x = c === p && t[i + 1].startsWith('/>') ? ' ' : '';
    l +=
      c === v
        ? s + r$2
        : d >= 0
          ? (e.push(a), s.slice(0, d) + h + s.slice(d) + o$2 + x)
          : s + o$2 + (-2 === d ? i : x);
  }
  return [V(t, l + (t[s] || '<?>') + (2 === i ? '</svg>' : 3 === i ? '</math>' : '')), e];
};
var S = class S {
  constructor({ strings: t, _$litType$: i }, e) {
    let r;
    this.parts = [];
    let l = 0,
      a = 0;
    const u = t.length - 1,
      d = this.parts,
      [f, v] = N(t, i);
    if (
      ((this.el = S.createElement(f, e)), (P.currentNode = this.el.content), 2 === i || 3 === i)
    ) {
      const t = this.el.content.firstChild;
      t.replaceWith(...t.childNodes);
    }
    for (; null !== (r = P.nextNode()) && d.length < u; ) {
      if (1 === r.nodeType) {
        if (r.hasAttributes())
          for (const t of r.getAttributeNames())
            if (t.endsWith(h)) {
              const i = v[a++],
                s = r.getAttribute(t).split(o$2),
                e = /([.?@])?(.*)/.exec(i);
              (d.push({
                type: 1,
                index: l,
                name: e[2],
                strings: s,
                ctor: '.' === e[1] ? I : '?' === e[1] ? L : '@' === e[1] ? z : H,
              }),
                r.removeAttribute(t));
            } else
              t.startsWith(o$2) &&
                (d.push({
                  type: 6,
                  index: l,
                }),
                r.removeAttribute(t));
        if (y.test(r.tagName)) {
          const t = r.textContent.split(o$2),
            i = t.length - 1;
          if (i > 0) {
            r.textContent = s$1 ? s$1.emptyScript : '';
            for (let s = 0; s < i; s++)
              (r.append(t[s], c()),
                P.nextNode(),
                d.push({
                  type: 2,
                  index: ++l,
                }));
            r.append(t[i], c());
          }
        }
      } else if (8 === r.nodeType)
        if (r.data === n$2)
          d.push({
            type: 2,
            index: l,
          });
        else {
          let t = -1;
          for (; -1 !== (t = r.data.indexOf(o$2, t + 1)); )
            (d.push({
              type: 7,
              index: l,
            }),
              (t += o$2.length - 1));
        }
      l++;
    }
  }
  static createElement(t, i) {
    const s = l.createElement('template');
    return ((s.innerHTML = t), s);
  }
};
function M(t, i, s = t, e) {
  if (i === E) return i;
  let h = void 0 !== e ? s._$Co?.[e] : s._$Cl;
  const o = a(i) ? void 0 : i._$litDirective$;
  return (
    h?.constructor !== o &&
      (h?._$AO?.(!1),
      void 0 === o ? (h = void 0) : ((h = new o(t)), h._$AT(t, s, e)),
      void 0 !== e ? ((s._$Co ??= [])[e] = h) : (s._$Cl = h)),
    void 0 !== h && (i = M(t, h._$AS(t, i.values), h, e)),
    i
  );
}
var R = class {
  constructor(t, i) {
    ((this._$AV = []), (this._$AN = void 0), (this._$AD = t), (this._$AM = i));
  }
  get parentNode() {
    return this._$AM.parentNode;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  u(t) {
    const {
        el: { content: i },
        parts: s,
      } = this._$AD,
      e = (t?.creationScope ?? l).importNode(i, !0);
    P.currentNode = e;
    let h = P.nextNode(),
      o = 0,
      n = 0,
      r = s[0];
    for (; void 0 !== r; ) {
      if (o === r.index) {
        let i;
        (2 === r.type
          ? (i = new k(h, h.nextSibling, this, t))
          : 1 === r.type
            ? (i = new r.ctor(h, r.name, r.strings, this, t))
            : 6 === r.type && (i = new Z(h, this, t)),
          this._$AV.push(i),
          (r = s[++n]));
      }
      o !== r?.index && ((h = P.nextNode()), o++);
    }
    return ((P.currentNode = l), e);
  }
  p(t) {
    let i = 0;
    for (const s of this._$AV)
      (void 0 !== s &&
        (void 0 !== s.strings ? (s._$AI(t, s, i), (i += s.strings.length - 2)) : s._$AI(t[i])),
        i++);
  }
};
var k = class k {
  get _$AU() {
    return this._$AM?._$AU ?? this._$Cv;
  }
  constructor(t, i, s, e) {
    ((this.type = 2),
      (this._$AH = A),
      (this._$AN = void 0),
      (this._$AA = t),
      (this._$AB = i),
      (this._$AM = s),
      (this.options = e),
      (this._$Cv = e?.isConnected ?? !0));
  }
  get parentNode() {
    let t = this._$AA.parentNode;
    const i = this._$AM;
    return (void 0 !== i && 11 === t?.nodeType && (t = i.parentNode), t);
  }
  get startNode() {
    return this._$AA;
  }
  get endNode() {
    return this._$AB;
  }
  _$AI(t, i = this) {
    ((t = M(this, t, i)),
      a(t)
        ? t === A || null == t || '' === t
          ? (this._$AH !== A && this._$AR(), (this._$AH = A))
          : t !== this._$AH && t !== E && this._(t)
        : void 0 !== t._$litType$
          ? this.$(t)
          : void 0 !== t.nodeType
            ? this.T(t)
            : d(t)
              ? this.k(t)
              : this._(t));
  }
  O(t) {
    return this._$AA.parentNode.insertBefore(t, this._$AB);
  }
  T(t) {
    this._$AH !== t && (this._$AR(), (this._$AH = this.O(t)));
  }
  _(t) {
    (this._$AH !== A && a(this._$AH)
      ? (this._$AA.nextSibling.data = t)
      : this.T(l.createTextNode(t)),
      (this._$AH = t));
  }
  $(t) {
    const { values: i, _$litType$: s } = t,
      e =
        'number' == typeof s
          ? this._$AC(t)
          : (void 0 === s.el && (s.el = S.createElement(V(s.h, s.h[0]), this.options)), s);
    if (this._$AH?._$AD === e) this._$AH.p(i);
    else {
      const t = new R(e, this),
        s = t.u(this.options);
      (t.p(i), this.T(s), (this._$AH = t));
    }
  }
  _$AC(t) {
    let i = C.get(t.strings);
    return (void 0 === i && C.set(t.strings, (i = new S(t))), i);
  }
  k(t) {
    u(this._$AH) || ((this._$AH = []), this._$AR());
    const i = this._$AH;
    let s,
      e = 0;
    for (const h of t)
      (e === i.length
        ? i.push((s = new k(this.O(c()), this.O(c()), this, this.options)))
        : (s = i[e]),
        s._$AI(h),
        e++);
    e < i.length && (this._$AR(s && s._$AB.nextSibling, e), (i.length = e));
  }
  _$AR(t = this._$AA.nextSibling, s) {
    for (this._$AP?.(!1, !0, s); t !== this._$AB; ) {
      const s = i$2(t).nextSibling;
      (i$2(t).remove(), (t = s));
    }
  }
  setConnected(t) {
    void 0 === this._$AM && ((this._$Cv = t), this._$AP?.(t));
  }
};
var H = class {
  get tagName() {
    return this.element.tagName;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  constructor(t, i, s, e, h) {
    ((this.type = 1),
      (this._$AH = A),
      (this._$AN = void 0),
      (this.element = t),
      (this.name = i),
      (this._$AM = e),
      (this.options = h),
      s.length > 2 || '' !== s[0] || '' !== s[1]
        ? ((this._$AH = Array(s.length - 1).fill(/* @__PURE__ */ new String())), (this.strings = s))
        : (this._$AH = A));
  }
  _$AI(t, i = this, s, e) {
    const h = this.strings;
    let o = !1;
    if (void 0 === h)
      ((t = M(this, t, i, 0)), (o = !a(t) || (t !== this._$AH && t !== E)), o && (this._$AH = t));
    else {
      const e = t;
      let n, r;
      for (t = h[0], n = 0; n < h.length - 1; n++)
        ((r = M(this, e[s + n], i, n)),
          r === E && (r = this._$AH[n]),
          (o ||= !a(r) || r !== this._$AH[n]),
          r === A ? (t = A) : t !== A && (t += (r ?? '') + h[n + 1]),
          (this._$AH[n] = r));
    }
    o && !e && this.j(t);
  }
  j(t) {
    t === A
      ? this.element.removeAttribute(this.name)
      : this.element.setAttribute(this.name, t ?? '');
  }
};
var I = class extends H {
  constructor() {
    (super(...arguments), (this.type = 3));
  }
  j(t) {
    this.element[this.name] = t === A ? void 0 : t;
  }
};
var L = class extends H {
  constructor() {
    (super(...arguments), (this.type = 4));
  }
  j(t) {
    this.element.toggleAttribute(this.name, !!t && t !== A);
  }
};
var z = class extends H {
  constructor(t, i, s, e, h) {
    (super(t, i, s, e, h), (this.type = 5));
  }
  _$AI(t, i = this) {
    if ((t = M(this, t, i, 0) ?? A) === E) return;
    const s = this._$AH,
      e =
        (t === A && s !== A) ||
        t.capture !== s.capture ||
        t.once !== s.once ||
        t.passive !== s.passive,
      h = t !== A && (s === A || e);
    (e && this.element.removeEventListener(this.name, this, s),
      h && this.element.addEventListener(this.name, this, t),
      (this._$AH = t));
  }
  handleEvent(t) {
    'function' == typeof this._$AH
      ? this._$AH.call(this.options?.host ?? this.element, t)
      : this._$AH.handleEvent(t);
  }
};
var Z = class {
    constructor(t, i, s) {
      ((this.element = t),
        (this.type = 6),
        (this._$AN = void 0),
        (this._$AM = i),
        (this.options = s));
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t) {
      M(this, t);
    }
  },
  B = t$2.litHtmlPolyfillSupport;
(B?.(S, k), (t$2.litHtmlVersions ??= []).push('3.3.2'));
var D = (t, i, s) => {
  const e = s?.renderBefore ?? i;
  let h = e._$litPart$;
  if (void 0 === h) {
    const t = s?.renderBefore ?? null;
    e._$litPart$ = h = new k(i.insertBefore(c(), t), t, void 0, s ?? {});
  }
  return (h._$AI(t), h);
};
//#endregion
//#region ../../node_modules/.pnpm/lit-element@4.2.2/node_modules/lit-element/lit-element.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ var s = globalThis;
var i$1 = class extends y$1 {
  constructor() {
    (super(...arguments), (this.renderOptions = { host: this }), (this._$Do = void 0));
  }
  createRenderRoot() {
    const t = super.createRenderRoot();
    return ((this.renderOptions.renderBefore ??= t.firstChild), t);
  }
  update(t) {
    const r = this.render();
    (this.hasUpdated || (this.renderOptions.isConnected = this.isConnected),
      super.update(t),
      (this._$Do = D(r, this.renderRoot, this.renderOptions)));
  }
  connectedCallback() {
    (super.connectedCallback(), this._$Do?.setConnected(!0));
  }
  disconnectedCallback() {
    (super.disconnectedCallback(), this._$Do?.setConnected(!1));
  }
  render() {
    return E;
  }
};
((i$1._$litElement$ = !0),
  (i$1['finalized'] = !0),
  s.litElementHydrateSupport?.({ LitElement: i$1 }));
var o$1 = s.litElementPolyfillSupport;
o$1?.({ LitElement: i$1 });
(s.litElementVersions ??= []).push('4.2.2');
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/custom-element.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var t$1 = (t) => (e, o) => {
  void 0 !== o
    ? o.addInitializer(() => {
        customElements.define(t, e);
      })
    : customElements.define(t, e);
};
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/property.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ var o = {
    attribute: !0,
    type: String,
    converter: u$1,
    reflect: !1,
    hasChanged: f$1,
  },
  r$1 = (t = o, e, r) => {
    const { kind: n, metadata: i } = r;
    let s = globalThis.litPropertyMetadata.get(i);
    if (
      (void 0 === s && globalThis.litPropertyMetadata.set(i, (s = /* @__PURE__ */ new Map())),
      'setter' === n && ((t = Object.create(t)).wrapped = !0),
      s.set(r.name, t),
      'accessor' === n)
    ) {
      const { name: o } = r;
      return {
        set(r) {
          const n = e.get.call(this);
          (e.set.call(this, r), this.requestUpdate(o, n, t, !0, r));
        },
        init(e) {
          return (void 0 !== e && this.C(o, void 0, t, e), e);
        },
      };
    }
    if ('setter' === n) {
      const { name: o } = r;
      return function (r) {
        const n = this[o];
        (e.call(this, r), this.requestUpdate(o, n, t, !0, r));
      };
    }
    throw Error('Unsupported decorator location: ' + n);
  };
function n$1(t) {
  return (e, o) =>
    'object' == typeof o
      ? r$1(t, e, o)
      : ((t, e, o) => {
          const r = e.hasOwnProperty(o);
          return (
            e.constructor.createProperty(o, t),
            r ? Object.getOwnPropertyDescriptor(e, o) : void 0
          );
        })(t, e, o);
}
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/state.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ function r(r) {
  return n$1({
    ...r,
    state: !0,
    attribute: !1,
  });
}
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/base.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var e$3 = (e, t, c) => (
  (c.configurable = !0),
  (c.enumerable = !0),
  Reflect.decorate && 'object' != typeof t && Object.defineProperty(e, t, c),
  c
);
//#endregion
//#region ../../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/query.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ function e$2(e, r) {
  return (n, s, i) => {
    const o = (t) => t.renderRoot?.querySelector(e) ?? null;
    if (r) {
      const { get: e, set: r } =
        'object' == typeof s
          ? n
          : (i ??
            (() => {
              const t = Symbol();
              return {
                get() {
                  return this[t];
                },
                set(e) {
                  this[t] = e;
                },
              };
            })());
      return e$3(n, s, {
        get() {
          let t = e.call(this);
          return (
            void 0 === t && ((t = o(this)), (null !== t || this.hasUpdated) && r.call(this, t)),
            t
          );
        },
      });
    }
    return e$3(n, s, {
      get() {
        return o(this);
      },
    });
  };
}
//#endregion
//#region \0@oxc-project+runtime@0.124.0/helpers/decorate.js
function __decorate(decorators, target, key, desc) {
  var c = arguments.length,
    r =
      c < 3 ? target : desc === null ? (desc = Object.getOwnPropertyDescriptor(target, key)) : desc,
    d;
  if (typeof Reflect === 'object' && typeof Reflect.decorate === 'function')
    r = Reflect.decorate(decorators, target, key, desc);
  else
    for (var i = decorators.length - 1; i >= 0; i--)
      if ((d = decorators[i])) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return (c > 3 && r && Object.defineProperty(target, key, r), r);
}
//#endregion
//#region ../../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/directive.js
/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
var t = {
    ATTRIBUTE: 1,
    CHILD: 2,
    PROPERTY: 3,
    BOOLEAN_ATTRIBUTE: 4,
    EVENT: 5,
    ELEMENT: 6,
  },
  e$1 =
    (t) =>
    (...e) => ({
      _$litDirective$: t,
      values: e,
    });
var i = class {
  constructor(t) {}
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AT(t, e, i) {
    ((this._$Ct = t), (this._$AM = e), (this._$Ci = i));
  }
  _$AS(t, e) {
    return this.update(t, e);
  }
  update(t, e) {
    return this.render(...e);
  }
};
//#endregion
//#region ../../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/directives/class-map.js
/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */ var e = e$1(
  class extends i {
    constructor(t$4) {
      if ((super(t$4), t$4.type !== t.ATTRIBUTE || 'class' !== t$4.name || t$4.strings?.length > 2))
        throw Error(
          '`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.',
        );
    }
    render(t) {
      return (
        ' ' +
        Object.keys(t)
          .filter((s) => t[s])
          .join(' ') +
        ' '
      );
    }
    update(s, [i]) {
      if (void 0 === this.st) {
        ((this.st = /* @__PURE__ */ new Set()),
          void 0 !== s.strings &&
            (this.nt = new Set(
              s.strings
                .join(' ')
                .split(/\s/)
                .filter((t) => '' !== t),
            )));
        for (const t in i) i[t] && !this.nt?.has(t) && this.st.add(t);
        return this.render(i);
      }
      const r = s.element.classList;
      for (const t of this.st) t in i || (r.remove(t), this.st.delete(t));
      for (const t in i) {
        const s = !!i[t];
        s === this.st.has(t) ||
          this.nt?.has(t) ||
          (s ? (r.add(t), this.st.add(t)) : (r.remove(t), this.st.delete(t)));
      }
      return E;
    }
  },
);
//#endregion
//#region ../../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/directives/when.js
/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
function n(n, r, t) {
  return n ? r(n) : t?.(n);
}
//#endregion
//#region src/sidepanel-tree-renderer.ts
/**
 * Tool tree rendering — builds the collapsible tree HTML for the tools panel.
 * Uses daisyUI/Tailwind utility classes.
 */
function renderToolsEmpty(message) {
  return b`<div
    class="flex flex-col items-center justify-center h-full text-base-content/40 p-5"
  >
    <p class="text-xs">${message}</p>
  </div>`;
}
function filterTab(tab, query) {
  const namespaces = tab.namespaces
    .map((namespace) => filterNamespace(namespace, query))
    .filter((namespace) => namespace !== null);
  const selfMatches =
    !query ||
    [tab.title, tab.url, String(tab.tabId)].some((value) => value.toLowerCase().includes(query));
  if (!selfMatches && namespaces.length === 0) return null;
  return {
    ...tab,
    namespaces: selfMatches ? tab.namespaces : namespaces,
  };
}
function filterBuiltins(builtins, query) {
  const sourceNamespaces = normalizeBuiltinNamespaces(builtins);
  if (!query)
    return {
      ...builtins,
      namespaces: sourceNamespaces,
      tools: sourceNamespaces.flatMap((namespace) =>
        namespace.instances.flatMap((instance) => instance.tools),
      ),
    };
  const namespaces = sourceNamespaces
    .map((namespace) => filterBuiltinNamespace(namespace, query))
    .filter((namespace) => namespace !== null);
  const tools = namespaces.flatMap((namespace) =>
    namespace.instances.flatMap((instance) => instance.tools),
  );
  return {
    ...builtins,
    namespaces,
    totalTools: tools.length,
    enabledTools: tools.filter((tool) => tool.enabled).length,
    tools,
  };
}
function renderBuiltinsNode(builtins) {
  const namespaces = normalizeBuiltinNamespaces(builtins);
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'tab',
          checked: builtins.enabledTools === builtins.totalTools && builtins.totalTools > 0,
          indeterminate: builtins.enabledTools > 0 && builtins.enabledTools < builtins.totalTools,
          data: {
            root: 'builtin',
            scope: 'builtin',
            tabId: 'builtin-root',
          },
          label: 'Built-in Tools',
          subtitle: 'Extension provided tools',
          meta: `${builtins.enabledTools}/${builtins.totalTools} enabled`,
          badges: [b`<span class="badge badge-xs badge-primary">builtin</span>`],
        })}
      </summary>
      ${namespaces.map((namespace) => renderBuiltinNamespaceNode(namespace))}
    </details>
  `;
}
function normalizeBuiltinNamespaces(builtins) {
  if (Array.isArray(builtins.namespaces) && builtins.namespaces.length > 0)
    return builtins.namespaces;
  const byNamespace = /* @__PURE__ */ new Map();
  for (const tool of builtins.tools ?? []) {
    const parts = tool.toolName.split('.');
    const namespace =
      tool.namespace ||
      (parts.length >= 3 && parts[0] === 'builtin' ? parts[1] : parts[0]) ||
      'builtin';
    const normalizedTool = {
      ...tool,
      namespace,
      instanceId: tool.instanceId || 'default',
    };
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), normalizedTool]);
  }
  return Array.from(byNamespace.entries())
    .map(([namespace, tools]) => ({
      kind: 'builtin-namespace',
      namespace,
      totalTools: tools.length,
      enabledTools: tools.filter((item) => item.enabled).length,
      instances: [
        {
          kind: 'builtin-instance',
          namespace,
          instanceId: 'default',
          totalTools: tools.length,
          enabledTools: tools.filter((item) => item.enabled).length,
          tools: tools.sort((left, right) => left.label.localeCompare(right.label)),
        },
      ],
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace));
}
function filterBuiltinNamespace(namespace, query) {
  const instances = namespace.instances
    .map((instance) => filterBuiltinInstance(instance, query))
    .filter((instance) => instance !== null);
  const selfMatches = !query || namespace.namespace.toLowerCase().includes(query);
  if (!selfMatches && instances.length === 0) return null;
  const finalInstances = selfMatches ? namespace.instances : instances;
  return {
    ...namespace,
    instances: finalInstances,
    totalTools: finalInstances.reduce((sum, item) => sum + item.totalTools, 0),
    enabledTools: finalInstances.reduce((sum, item) => sum + item.enabledTools, 0),
  };
}
function filterBuiltinInstance(instance, query) {
  const tools = instance.tools.filter((tool) => matchesBuiltinTool(tool, query));
  const selfMatches = !query || instance.instanceId.toLowerCase().includes(query);
  if (!selfMatches && tools.length === 0) return null;
  const finalTools = selfMatches ? instance.tools : tools;
  return {
    ...instance,
    tools: finalTools,
    totalTools: finalTools.length,
    enabledTools: finalTools.filter((tool) => tool.enabled).length,
  };
}
function matchesBuiltinTool(tool, query) {
  if (!query) return true;
  return [tool.namespace, tool.instanceId, tool.label, tool.toolName, tool.description ?? ''].some(
    (value) => value.toLowerCase().includes(query),
  );
}
function renderBuiltinNamespaceNode(namespace) {
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'namespace',
          checked: namespace.enabledTools === namespace.totalTools && namespace.totalTools > 0,
          indeterminate:
            namespace.enabledTools > 0 && namespace.enabledTools < namespace.totalTools,
          toggleDisabled: namespace.instances.every((instance) =>
            instance.tools.every((tool) => isBridgeControlBuiltinTool(tool)),
          ),
          data: {
            root: 'builtin',
            scope: 'builtin',
            tabId: 'builtin-root',
            namespace: namespace.namespace,
          },
          label: namespace.namespace,
          subtitle: 'Builtin namespace',
          meta: `${namespace.enabledTools}/${namespace.totalTools} enabled`,
          badges: [b`<span class="badge badge-xs badge-secondary">namespace</span>`],
        })}
      </summary>
      ${namespace.instances.map((instance) => renderBuiltinInstanceNode(instance))}
    </details>
  `;
}
function renderBuiltinInstanceNode(instance) {
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'instance',
          checked: instance.enabledTools === instance.totalTools && instance.totalTools > 0,
          indeterminate: instance.enabledTools > 0 && instance.enabledTools < instance.totalTools,
          toggleDisabled: instance.tools.every((tool) => isBridgeControlBuiltinTool(tool)),
          data: {
            root: 'builtin',
            scope: 'builtin',
            tabId: 'builtin-root',
            namespace: instance.namespace,
            instanceId: instance.instanceId,
          },
          label: instance.instanceId,
          subtitle: instance.instanceId === 'default' ? 'Default instance' : 'Builtin instance',
          meta: `${instance.enabledTools}/${instance.totalTools} enabled`,
          badges: [b`<span class="badge badge-xs badge-accent">instance</span>`],
        })}
      </summary>
      ${instance.tools.map((tool) => renderBuiltinToolNode(tool))}
    </details>
  `;
}
function renderTabNode(tab) {
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'tab',
          checked: tab.enabledTools === tab.totalTools && tab.totalTools > 0,
          indeterminate: tab.enabledTools > 0 && tab.enabledTools < tab.totalTools,
          data: {
            root: 'page',
            scope: 'tab',
            tabId: String(tab.tabId),
          },
          label: tab.title,
          subtitle: tab.url ? tab.url : '',
          meta: `${tab.enabledTools}/${tab.totalTools} enabled`,
          badges: [
            tab.active ? b`<span class="badge badge-xs badge-success">active</span>` : A,
            b`<span class="badge badge-xs badge-ghost">tab ${tab.tabId}</span>`,
          ],
        })}
      </summary>
      ${tab.namespaces.map((namespace) => renderNamespaceNode(namespace))}
    </details>
  `;
}
function filterNamespace(namespace, query) {
  const instances = namespace.instances
    .map((instance) => filterInstance(instance, query))
    .filter((instance) => instance !== null);
  const selfMatches =
    !query ||
    [namespace.namespace, namespace.title ?? '', namespace.description ?? ''].some((value) =>
      value.toLowerCase().includes(query),
    );
  if (!selfMatches && instances.length === 0) return null;
  return {
    ...namespace,
    instances: selfMatches ? namespace.instances : instances,
  };
}
function filterInstance(instance, query) {
  const tools = instance.tools.filter((tool) => matchesTool(tool, query));
  const selfMatches = !query || instance.instanceId.toLowerCase().includes(query);
  if (!selfMatches && tools.length === 0) return null;
  return {
    ...instance,
    tools: selfMatches ? instance.tools : tools,
  };
}
function matchesTool(tool, query) {
  if (!query) return true;
  return [tool.toolName, tool.label, tool.description ?? ''].some((value) =>
    value.toLowerCase().includes(query),
  );
}
function getNamespaceDisplayContent(namespace) {
  return {
    label: namespace.title?.trim() || namespace.namespace,
    subtitle: namespace.description?.trim() || 'Namespace',
  };
}
function renderNamespaceNode(namespace) {
  const namespaceDisplayContent = getNamespaceDisplayContent(namespace);
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'namespace',
          checked: namespace.enabledTools === namespace.totalTools && namespace.totalTools > 0,
          indeterminate:
            namespace.enabledTools > 0 && namespace.enabledTools < namespace.totalTools,
          data: {
            root: 'page',
            scope: 'namespace',
            tabId: String(namespace.tabId),
            namespace: namespace.namespace,
          },
          label: namespaceDisplayContent.label,
          subtitle: namespaceDisplayContent.subtitle,
          meta: `${namespace.enabledTools}/${namespace.totalTools} enabled`,
          badges: [b`<span class="badge badge-xs badge-secondary">namespace</span>`],
        })}
      </summary>
      ${namespace.instances.map((instance) => renderInstanceNode(instance))}
    </details>
  `;
}
function renderInstanceNode(instance) {
  return b`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'instance',
          checked: instance.enabledTools === instance.totalTools && instance.totalTools > 0,
          indeterminate: instance.enabledTools > 0 && instance.enabledTools < instance.totalTools,
          data: {
            root: 'page',
            scope: 'instance',
            tabId: String(instance.tabId),
            namespace: instance.namespace,
            instanceId: instance.instanceId,
          },
          label: instance.instanceId,
          subtitle: instance.instanceId === 'default' ? 'Default instance' : 'Instance',
          meta: `${instance.enabledTools}/${instance.totalTools} enabled`,
          badges: [b`<span class="badge badge-xs badge-accent">instance</span>`],
        })}
      </summary>
      ${instance.tools.map((tool) => renderToolNode(tool))}
    </details>
  `;
}
function renderBuiltinToolNode(tool) {
  const bridgeControl = isBridgeControlBuiltinTool(tool);
  const subtitle = bridgeControl
    ? `${tool.description ? tool.description : tool.toolName} (Bridge/MCP control tool, display only)`
    : tool.description
      ? tool.description
      : tool.toolName;
  return renderTreeRow({
    level: 'tool',
    checked: tool.enabled,
    indeterminate: false,
    toggleDisabled: bridgeControl,
    data: {
      root: 'builtin',
      scope: 'builtin',
      tabId: 'builtin-root',
      toolName: tool.toolName,
    },
    label: tool.label,
    subtitle,
    meta: tool.toolName,
    badges: [
      bridgeControl ? b`<span class="badge badge-xs badge-info">bridge</span>` : A,
      tool.readOnly ? b`<span class="badge badge-xs badge-success">readonly</span>` : A,
    ],
    actions: bridgeControl
      ? void 0
      : renderTestButton({
          root: 'builtin',
          toolName: tool.toolName,
          label: tool.label,
          inputSchema: tool.inputSchema,
        }),
  });
}
function renderToolNode(tool) {
  return renderTreeRow({
    level: 'tool',
    checked: tool.enabled,
    indeterminate: false,
    data: {
      root: 'page',
      scope: 'tool',
      tabId: String(tool.tabId),
      namespace: tool.namespace,
      instanceId: tool.instanceId,
      toolName: tool.toolName,
    },
    label: tool.label,
    subtitle: tool.description ? tool.description : tool.toolName,
    meta: tool.toolName,
    badges: [tool.readOnly ? b`<span class="badge badge-xs badge-success">readonly</span>` : A],
    actions: renderTestButton({
      root: 'page',
      toolName: tool.toolName,
      label: tool.label,
      tabId: tool.tabId,
      inputSchema: tool.inputSchema,
    }),
  });
}
var INDENT_CLASS = {
  tab: '',
  namespace: 'tree-indent-1',
  instance: 'tree-indent-2',
  tool: 'tree-indent-3',
};
function renderTreeRow(input) {
  return b`
    <div
      class="flex items-start gap-2 px-3 py-2 border-b border-base-200 bg-base-100 hover:bg-base-200/50 ${INDENT_CLASS[input.level]}"
    >
      <input
        type="checkbox"
        class="checkbox checkbox-xs checkbox-primary mt-0.5 shrink-0"
        .checked=${input.checked}
        .disabled=${Boolean(input.toggleDisabled)}
        data-indeterminate=${input.indeterminate ? 'true' : 'false'}
        data-root=${input.data.root ?? A}
        data-scope=${input.data.scope ?? A}
        data-tab-id=${input.data.tabId ?? A}
        data-namespace=${input.data.namespace ?? A}
        data-instance-id=${input.data.instanceId ?? A}
        data-tool-name=${input.data.toolName ?? A}
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 flex-wrap text-xs font-semibold">
          ${input.label}<span class="badge badge-xs badge-ghost">${input.meta}</span>${input.badges}
        </div>
        ${
          input.subtitle
            ? b`<div class="mt-0.5 text-xs opacity-60 break-all leading-snug">
              ${input.subtitle}
            </div>`
            : A
        }
      </div>
      ${input.actions ? b`<div class="flex items-center gap-1.5 ml-auto shrink-0">${input.actions}</div>` : A}
    </div>
  `;
}
function isBridgeControlBuiltinTool(tool) {
  if (tool.bridgeControl === true) return true;
  return tool.toolName.startsWith('extension.') || tool.toolName.startsWith('feedback.');
}
function renderTestButton(input) {
  return b`
    <button
      type="button"
      class="btn btn-xs btn-outline btn-primary rounded-full"
      data-action="test-tool"
      data-root=${input.root}
      data-tool-name=${input.toolName}
      data-label=${input.label}
      data-schema=${JSON.stringify(input.inputSchema ?? {})}
      data-tab-id=${input.tabId != null ? String(input.tabId) : A}
    >
      Test
    </button>
  `;
}
function createArgsTemplate(schema) {
  if (!schema || typeof schema !== 'object') return '{}';
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const template = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!required.has(key) && property.default === void 0) continue;
    if (property.default !== void 0) {
      template[key] = property.default;
      continue;
    }
    switch (property.type) {
      case 'number':
      case 'integer':
        template[key] = 0;
        break;
      case 'boolean':
        template[key] = false;
        break;
      case 'array':
        template[key] = [];
        break;
      case 'object':
        template[key] = {};
        break;
      default:
        template[key] = '';
        break;
    }
  }
  return formatJson(template);
}
function formatJson(value) {
  return JSON.stringify(value, null, 2);
}
function safeParseJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
//#endregion
//#region src/context-manifest-diff.ts
function buildContextManifestDiff(rawManifest, effectiveManifest) {
  const rawNamespaces = rawManifest?.namespaces.map((entry) => entry.namespace) ?? [];
  const effectiveNamespaces = effectiveManifest?.namespaces.map((entry) => entry.namespace) ?? [];
  const rawResources = rawManifest?.resources.map((entry) => entry.id) ?? [];
  const effectiveResources = effectiveManifest?.resources.map((entry) => entry.id) ?? [];
  const rawSkills = rawManifest?.skills.map((entry) => entry.id) ?? [];
  const effectiveSkills = effectiveManifest?.skills.map((entry) => entry.id) ?? [];
  return {
    rawNamespaces: rawNamespaces.length,
    effectiveNamespaces: effectiveNamespaces.length,
    hiddenNamespaces: diff(rawNamespaces, effectiveNamespaces),
    rawResources: rawResources.length,
    effectiveResources: effectiveResources.length,
    hiddenResources: diff(rawResources, effectiveResources),
    rawSkills: rawSkills.length,
    effectiveSkills: effectiveSkills.length,
    hiddenSkills: diff(rawSkills, effectiveSkills),
    sceneChanged: (rawManifest?.scene ?? '') !== (effectiveManifest?.scene ?? ''),
  };
}
function diff(rawItems, effectiveItems) {
  const effectiveSet = new Set(effectiveItems);
  return rawItems.filter((item) => !effectiveSet.has(item));
}
//#endregion
//#region src/sidepanel-context-panel.ts
/**
 * Context manifest 面板渲染模块。
 * 提供 namespace / resource / skill 卡片组件和 diff 面板的纯渲染函数。
 */
/**
 * 将过滤原因码转译为人类可读文案。
 * 统一出口，避免在 side-panel-app 和 panel 中各写一份。
 */
function formatReason(reason) {
  switch (reason) {
    case 'namespace_disabled':
      return 'disabled by namespace';
    case 'builtin_tool_disabled':
      return 'disabled by built-in tool filter';
    case 'page_tool_disabled':
      return 'disabled by page tool filter';
    case 'scene_filtered':
      return 'filtered by scene';
    default:
      return 'unknown reason';
  }
}
/** 渲染 namespace 描述为紧凑的业务域卡片 */
function renderContextNamespaceCard(namespace) {
  const tags = namespace.tags ?? [];
  return b`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="card-title text-xs font-bold">${namespace.title}</div>
          <span class="badge badge-xs badge-primary">${namespace.namespace}</span>
        </div>
        <p class="text-xs opacity-60 break-words">
          ${namespace.description ?? `Declared namespace ${namespace.namespace}.`}
        </p>
        ${
          tags.length > 0
            ? b`<div class="flex gap-1 flex-wrap mt-0.5">
              ${tags.map((tag) => b`<span class="badge badge-xs badge-ghost">${tag}</span>`)}
            </div>`
            : A
        }
      </div>
    </div>
  `;
}
/** 渲染 resource 描述为数据卡片（含 "Inspect Payload" 按钮） */
function renderContextResourceCard(resource) {
  const tags = resource.tags ?? [];
  return b`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${resource.title}</div>
        <p class="text-xs opacity-60 break-words">${resource.description ?? resource.id}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${resource.namespace}</span>
          <span class="badge badge-xs badge-ghost">${resource.kind ?? 'resource'}</span>
          ${resource.mimeType ? b`<span class="badge badge-xs badge-outline">${resource.mimeType}</span>` : A}
        </div>
        ${
          tags.length > 0
            ? b`<div class="flex gap-1 flex-wrap mt-0.5">
              ${tags.map((tag) => b`<span class="badge badge-xs badge-ghost">${tag}</span>`)}
            </div>`
            : A
        }
        <p class="text-[11px] opacity-55">
          Agents can inspect this payload directly from the current page state.
        </p>
        <div class="card-actions mt-1">
          <button
            class="btn btn-xs btn-primary"
            type="button"
            data-action="read-resource"
            data-resource-id="${resource.id}"
          >
            Inspect Payload
          </button>
        </div>
      </div>
    </div>
  `;
}
/** 渲染 skill 描述为工作流卡片（含 "Inspect Skill" 按钮） */
function renderContextSkillCard(skill) {
  const intentTags = skill.intentTags ?? [];
  const linkedResourceCount = skill.resourceIds?.length ?? 0;
  const linkedToolCount = skill.toolNames?.length ?? 0;
  return b`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${skill.title}</div>
        <p class="text-xs opacity-60 break-words">${skill.description}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${skill.namespace}</span>
          <span class="badge badge-xs badge-ghost">${skill.mode ?? 'analysis'}</span>
          <span class="badge badge-xs badge-outline">
            ${linkedResourceCount} ${linkedResourceCount === 1 ? 'resource' : 'resources'}
          </span>
          <span class="badge badge-xs badge-outline">
            ${linkedToolCount} ${linkedToolCount === 1 ? 'tool' : 'tools'}
          </span>
        </div>
        ${
          intentTags.length > 0
            ? b`<div class="flex gap-1 flex-wrap mt-0.5">
              ${intentTags.map((tag) => b`<span class="badge badge-xs badge-ghost">${tag}</span>`)}
            </div>`
            : A
        }
        <p class="text-[11px] opacity-55">
          Uses page-grounded context before the agent expands into tools or workflows.
        </p>
        <div class="card-actions mt-1">
          <button
            class="btn btn-xs btn-primary"
            type="button"
            data-action="preview-skill"
            data-skill-id="${skill.id}"
          >
            Inspect Skill
          </button>
        </div>
      </div>
    </div>
  `;
}
//#endregion
//#region src/sidepanel-feedback.ts
function createFeedbackActionState() {
  return {
    mode: null,
    replyBody: '',
    resolveNote: '',
    dismissReason: '',
    submitting: false,
    error: '',
    success: '',
  };
}
function reconcileFeedbackActionStates(current, annotations) {
  const next = {};
  for (const annotation of annotations)
    next[annotation.id] = current[annotation.id] ?? createFeedbackActionState();
  return next;
}
function readFeedbackActionState(current, annotationId) {
  return current[annotationId] ?? createFeedbackActionState();
}
function updateFeedbackActionStates(current, annotationId, updater) {
  return {
    ...current,
    [annotationId]: updater(readFeedbackActionState(current, annotationId)),
  };
}
function feedbackStatusBadgeClass(status) {
  switch (status) {
    case 'resolved':
      return 'badge badge-success badge-sm';
    case 'claimed':
      return 'badge badge-info badge-sm';
    case 'dismissed':
      return 'badge badge-ghost badge-sm';
    default:
      return 'badge badge-warning badge-sm';
  }
}
function feedbackPushAgentBadgeClass(status) {
  if (!status || !status.enabled) return 'badge badge-ghost badge-sm';
  const lastResult = status.lastLaunch?.result;
  if (lastResult === 'failed') return 'badge badge-error badge-sm';
  if (lastResult === 'success') return 'badge badge-success badge-sm';
  return 'badge badge-info badge-sm';
}
function feedbackPushAgentBadgeText(status) {
  if (!status) return 'unknown';
  if (!status.enabled) return 'disabled';
  const lastResult = status.lastLaunch?.result;
  if (lastResult === 'failed') return 'last launch failed';
  if (lastResult === 'success') return 'last launch ok';
  return 'ready';
}
function canClaimAnnotation(status) {
  return status === 'open' || status === 'needs_info';
}
function canReplyAnnotation(status) {
  return status !== 'resolved' && status !== 'dismissed';
}
function canResolveAnnotation(status) {
  return status === 'claimed' || status === 'in_progress' || status === 'needs_info';
}
function canDismissAnnotation(status) {
  return status !== 'resolved' && status !== 'dismissed';
}
function formatFeedbackTime(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('en-US', { hour12: false });
}
function renderFeedbackThread(annotation) {
  if (annotation.thread.length === 0)
    return b`<div class="text-xs opacity-50">No thread messages</div>`;
  return b`
    <div class="flex flex-col gap-1">
      ${annotation.thread.map(
        (message) => b`
          <div class="border border-base-300 rounded-md p-2 bg-base-200/60 flex flex-col gap-1">
            <div class="flex items-center gap-1 text-[11px] opacity-70">
              <span class="font-semibold">${message.author.displayName}</span>
              <span class="badge badge-ghost badge-xs">${message.author.source}</span>
              <span class="badge badge-outline badge-xs">${message.kind}</span>
              <span class="ml-auto">${formatFeedbackTime(message.createdAt)}</span>
            </div>
            <div class="text-xs whitespace-pre-wrap break-words">${message.body}</div>
          </div>
        `,
      )}
    </div>
  `;
}
function renderFeedbackActionForm(annotation, state, callbacks) {
  if (state.mode === 'reply')
    return b`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder="Add processing progress or follow-up questions"
          .value=${state.replyBody}
          @input=${(event) => callbacks.onInput(annotation.id, 'replyBody', event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            Cancel
          </button>
          <button
            class="btn btn-xs btn-primary ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onReply(annotation.id)}
          >
            ${state.submitting ? 'Submitting...' : 'Submit Reply'}
          </button>
        </div>
      </div>
    `;
  if (state.mode === 'resolve')
    return b`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <textarea
          class="textarea textarea-sm textarea-bordered min-h-[4.5rem]"
          placeholder="Optional: fill in resolution notes"
          .value=${state.resolveNote}
          @input=${(event) => callbacks.onInput(annotation.id, 'resolveNote', event)}
        ></textarea>
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            Cancel
          </button>
          <button
            class="btn btn-xs btn-success ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onResolve(annotation.id)}
          >
            ${state.submitting ? 'Submitting...' : 'Confirm Resolve'}
          </button>
        </div>
      </div>
    `;
  if (state.mode === 'dismiss')
    return b`
      <div class="border border-base-300 rounded-md p-2 bg-base-200/50 flex flex-col gap-2">
        <input
          class="input input-sm input-bordered"
          placeholder="Optional: fill in dismiss reason"
          .value=${state.dismissReason}
          @input=${(event) => callbacks.onInput(annotation.id, 'dismissReason', event)}
        />
        <div class="flex items-center gap-2">
          <button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, null)}
          >
            Cancel
          </button>
          <button
            class="btn btn-xs btn-warning ml-auto"
            .disabled=${state.submitting}
            @click=${() => callbacks.onDismiss(annotation.id)}
          >
            ${state.submitting ? 'Submitting...' : 'Confirm Dismiss'}
          </button>
        </div>
      </div>
    `;
  return b``;
}
function renderFeedbackActions(annotation, state, callbacks) {
  const canClaim = canClaimAnnotation(annotation.status);
  const canReply = canReplyAnnotation(annotation.status);
  const canResolve = canResolveAnnotation(annotation.status);
  const canDismiss = canDismissAnnotation(annotation.status);
  return b`
    <div class="flex flex-wrap items-center gap-1.5">
      ${
        canClaim
          ? b`<button
            class="btn btn-xs btn-info"
            .disabled=${state.submitting}
            @click=${() => callbacks.onClaim(annotation.id)}
          >
            ${state.submitting ? 'Submitting...' : 'Claim'}
          </button>`
          : A
      }
      ${
        canReply
          ? b`<button
            class="btn btn-xs btn-ghost"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, 'reply')}
          >
            Reply
          </button>`
          : A
      }
      ${
        canResolve
          ? b`<button
            class="btn btn-xs btn-success btn-outline"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, 'resolve')}
          >
            Resolve
          </button>`
          : A
      }
      ${
        canDismiss
          ? b`<button
            class="btn btn-xs btn-warning btn-outline"
            .disabled=${state.submitting}
            @click=${() => callbacks.onToggleMode(annotation.id, 'dismiss')}
          >
            Dismiss
          </button>`
          : A
      }
      ${!canClaim && !canReply && !canResolve && !canDismiss ? b`<span class="text-xs opacity-50">No actions available in current state</span>` : A}
    </div>
    ${state.error ? b`<div class="text-xs text-error">${state.error}</div>` : A}
    ${state.success ? b`<div class="text-xs text-success">${state.success}</div>` : A}
    ${renderFeedbackActionForm(annotation, state, callbacks)}
  `;
}
function renderFeedbackTab(input) {
  const currentFeedbackSession = input.snapshot?.sessions[0] ?? null;
  const feedbackAnnotations = input.snapshot?.annotations ?? [];
  const feedbackPushAgentStatus = input.snapshot?.pushAgent ?? null;
  return b`
    <div class="tab-content active flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <span class="text-xs font-bold uppercase tracking-wide opacity-60">Feedback</span>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="flex-1 overflow-y-auto p-3 bg-base-200 flex flex-col gap-3">
        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="flex items-center gap-2">
              <div class="font-bold text-sm">Auto Push Agent</div>
              <span class="${feedbackPushAgentBadgeClass(feedbackPushAgentStatus)} ml-auto"
                >${feedbackPushAgentBadgeText(feedbackPushAgentStatus)}</span
              >
            </div>
            ${
              !feedbackPushAgentStatus
                ? b`<div class="text-xs opacity-60">
                  Current snapshot does not contain push-agent status.
                </div>`
                : b`
                  <div class="text-xs opacity-70">
                    enabled:
                    <span class="font-mono">${String(feedbackPushAgentStatus.enabled)}</span> ·
                    readiness: <span class="font-mono">${feedbackPushAgentStatus.readiness}</span> ·
                    mode: <span class="font-mono">${feedbackPushAgentStatus.mode}</span>
                  </div>
                  ${
                    feedbackPushAgentStatus.lastLaunch
                      ? b`
                        <div class="text-xs opacity-70">
                          last launch:
                          <span class="font-mono"
                            >${feedbackPushAgentStatus.lastLaunch.result}</span
                          >
                          · at ${formatFeedbackTime(feedbackPushAgentStatus.lastLaunch.attemptedAt)}
                          · annotation ${feedbackPushAgentStatus.lastLaunch.annotationId}
                        </div>
                        ${
                          feedbackPushAgentStatus.lastLaunch.failureReason
                            ? b`<div class="text-xs text-error">
                              failure: ${feedbackPushAgentStatus.lastLaunch.failureReason}
                            </div>`
                            : A
                        }
                      `
                      : b`<div class="text-xs opacity-60">last launch: (no records yet)</div>`
                  }
                `
            }
          </div>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="font-bold text-sm">Create Feedback</div>
            <textarea
              class="textarea textarea-sm textarea-bordered min-h-[6rem]"
              placeholder="Describe the problem, expected behavior, reproduction steps"
              .value=${input.body}
              @input=${input.onBodyInput}
            ></textarea>
            <div class="flex gap-2 items-center">
              <label class="text-xs opacity-70" for="feedbackPriority">Priority</label>
              <select
                id="feedbackPriority"
                class="select select-sm select-bordered w-36"
                .value=${input.priority}
                @change=${input.onPriorityChange}
              >
                <option value="low">low</option>
                <option value="normal">normal</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
              <button class="btn btn-sm btn-primary ml-auto" @click=${input.onSubmit}>
                Submit
              </button>
            </div>
            <div class="text-xs opacity-70">
              ${
                currentFeedbackSession
                  ? b`Active Tab: #${currentFeedbackSession.tabId} ·
                  ${currentFeedbackSession.title || currentFeedbackSession.url}`
                  : b`Active Tab: (session not created)`
              }
            </div>
            ${
              feedbackAnnotations[0]?.target.textQuote
                ? b`<div class="text-xs opacity-70">
                  Selected Text: ${feedbackAnnotations[0].target.textQuote}
                </div>`
                : A
            }
            <div class="${input.createStatusClass}">${input.createStatus}</div>
          </div>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm">
          <div class="card-body p-3 gap-2">
            <div class="flex items-center justify-between">
              <div class="font-bold text-sm">Current Session</div>
              <div class="text-xs opacity-60">
                ${input.loading ? 'Loading...' : `${feedbackAnnotations.length} annotations`}
              </div>
            </div>
            ${input.error ? b`<div class="text-xs text-error">${input.error}</div>` : A}
            ${
              !currentFeedbackSession
                ? b`<div class="text-xs opacity-60">
                  No feedback records for current page yet.
                </div>`
                : b`
                  <div class="text-xs opacity-70">
                    Session ${currentFeedbackSession.id} · seq
                    ${currentFeedbackSession.lastEventSeq}
                  </div>
                  <div class="flex flex-col gap-2">
                    ${
                      feedbackAnnotations.length === 0
                        ? b`<div class="text-xs opacity-60">No annotations yet.</div>`
                        : b`${feedbackAnnotations.map((annotation) => {
                            const state = input.readActionState(annotation.id);
                            return b`
                            <div
                              class="border border-base-300 rounded-lg p-2 bg-base-100 flex flex-col gap-1.5"
                            >
                              <div class="flex items-center gap-2">
                                <span class="${feedbackStatusBadgeClass(annotation.status)}"
                                  >${annotation.status}</span
                                >
                                <span class="badge badge-outline badge-sm"
                                  >${annotation.priority}</span
                                >
                                <span class="text-[11px] opacity-50 ml-auto"
                                  >${formatFeedbackTime(annotation.updatedAt)}</span
                                >
                              </div>
                              <div class="text-sm whitespace-pre-wrap break-words">
                                ${annotation.body}
                              </div>
                              <div class="text-xs opacity-70">
                                #${annotation.id} · by ${annotation.author.displayName} · created
                                ${formatFeedbackTime(annotation.createdAt)}
                              </div>
                              ${
                                annotation.target.textQuote
                                  ? b`<div class="text-xs opacity-80">
                                    Quote: ${annotation.target.textQuote}
                                  </div>`
                                  : A
                              }
                              ${
                                annotation.claimedBy ||
                                annotation.resolvedBy ||
                                annotation.resolution ||
                                annotation.dismissReason
                                  ? b`
                                    <div class="text-xs opacity-70 flex flex-wrap gap-2">
                                      ${
                                        annotation.claimedBy
                                          ? b`<span
                                            >Claimed by: ${annotation.claimedBy.displayName}</span
                                          >`
                                          : A
                                      }
                                      ${
                                        annotation.resolvedBy
                                          ? b`<span
                                            >Resolved by: ${annotation.resolvedBy.displayName}</span
                                          >`
                                          : A
                                      }
                                      ${annotation.resolution ? b`<span>Resolution: ${annotation.resolution}</span>` : A}
                                      ${
                                        annotation.dismissReason
                                          ? b`<span
                                            >Dismiss reason: ${annotation.dismissReason}</span
                                          >`
                                          : A
                                      }
                                    </div>
                                  `
                                  : A
                              }
                              ${
                                annotation.linkedCapabilities.relatedToolNames.length +
                                  annotation.linkedCapabilities.relatedResourceIds.length +
                                  annotation.linkedCapabilities.relatedSkillIds.length >
                                0
                                  ? b`
                                    <div class="flex flex-wrap gap-1">
                                      ${annotation.linkedCapabilities.relatedToolNames.map(
                                        (tool) => b`<span class="badge badge-ghost badge-xs"
                                            >tool:${tool}</span
                                          >`,
                                      )}
                                      ${annotation.linkedCapabilities.relatedResourceIds.map(
                                        (resource) => b`<span class="badge badge-ghost badge-xs"
                                            >resource:${resource}</span
                                          >`,
                                      )}
                                      ${annotation.linkedCapabilities.relatedSkillIds.map(
                                        (skill) => b`<span class="badge badge-ghost badge-xs"
                                            >skill:${skill}</span
                                          >`,
                                      )}
                                    </div>
                                  `
                                  : b`<div class="text-xs opacity-50">
                                    No related capabilities
                                  </div>`
                              }
                              ${renderFeedbackActions(annotation, state, {
                                onToggleMode: input.onToggleMode,
                                onInput: input.onActionInput,
                                onClaim: input.onClaim,
                                onReply: input.onReply,
                                onResolve: input.onResolve,
                                onDismiss: input.onDismiss,
                              })}
                              ${renderFeedbackThread(annotation)}
                            </div>
                          `;
                          })}`
                    }
                  </div>
                `
            }
          </div>
        </div>
      </div>
    </div>
  `;
}
//#endregion
//#region src/sidepanel-tools-view.ts
function renderToolsTab(input) {
  return b`
    <div class="tab-content ${input.active ? 'active' : ''} flex flex-col flex-1 min-h-0">
      <div
        class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 sticky top-0 z-10"
      >
        <span class="text-xs font-bold uppercase tracking-wide opacity-60">Context Tools</span>
        <span
          data-testid="build-time-label"
          class="text-xs opacity-50 truncate"
          title=${input.toolsCount}
          >${input.toolsCount}</span
        >
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="px-3 py-1.5 border-b border-base-300 bg-base-200 sticky top-[2.75rem] z-20">
        <input
          type="search"
          .value=${input.currentFilter}
          @input=${input.onFilterInput}
          placeholder="Filter by tab / namespace / instance / tool"
          class="input input-sm input-bordered w-full"
        />
      </div>
      <div
        class="flex-1 overflow-y-auto"
        id="toolsPanel"
        @change=${input.onPanelChange}
        @click=${input.onPanelClick}
      >
        ${input.renderToolsTreeContent()}
      </div>

      ${
        input.currentToolTestSelection
          ? b`
            <div
              class="test-panel open border-t border-base-300 bg-base-100 p-3 flex-col gap-2 shrink-0 max-h-[48%] overflow-auto"
            >
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="text-sm font-bold">${input.toolTestTitle}</div>
                  <div class="text-xs opacity-60 break-all">${input.toolTestSubtitle}</div>
                </div>
                <button class="btn btn-xs btn-ghost" @click=${input.onCloseToolTestPanel}>
                  Close
                </button>
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestTabIdInput">Tab ID</label>
                <input
                  id="toolTestTabIdInput"
                  type="number"
                  .value=${input.toolTestTabIdValue}
                  .disabled=${input.toolTestTabIdDisabled}
                  @input=${input.onToolTestTabIdInput}
                  placeholder="Optional for built-in tools"
                  class="input input-sm input-bordered"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestSchemaOutput"
                  >Input Schema</label
                >
                <pre
                  class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
                >
${input.toolTestSchemaOutput}</pre
                >
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestArgsInput"
                  >RPC Args (JSON)</label
                >
                <textarea
                  id="toolTestArgsInput"
                  class="textarea textarea-sm textarea-bordered font-mono min-h-[5.5rem]"
                  .value=${input.toolTestArgs}
                  @input=${input.onToolTestArgsInput}
                ></textarea>
              </div>
              <div class="flex gap-2 justify-end">
                <button class="btn btn-xs btn-ghost" @click=${input.onResetToolTestArgs}>
                  Reset Args
                </button>
                <button
                  class="btn btn-xs btn-primary"
                  .disabled=${input.toolTestRunning}
                  @click=${input.onRunToolDebugCall}
                >
                  Run RPC Call
                </button>
              </div>
              <div class="text-xs font-semibold ${input.toolTestStatusClass}">
                ${input.toolTestStatusText}
              </div>
              <div class="flex flex-col gap-1">
                <label class="label text-xs font-semibold" for="toolTestOutput">Output</label>
                <pre
                  class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words min-h-[3rem]"
                >
${input.toolTestOutput}</pre
                >
              </div>
            </div>
          `
          : b``
      }
    </div>
  `;
}
//#endregion
//#region src/sidepanel-context-controller.ts
/**
 * Context Tab 纯渲染函数（从 SidePanelApp 中抽离）。
 * 接收预计算好的状态，输出完整的 Page Capabilities 面板模板。
 */
/** 单复数格式化：count 为 1 时用 singular，否则用 plural */
function pluralize(countText, singular, plural = `${singular}s`) {
  return countText === '1' ? singular : plural;
}
/** 生成能力摘要文案：Bridge 当前能看到多少资源/技能/命名空间 */
function buildCapabilityBriefing(input) {
  return `Bridge sees ${input.contextResourceCount} ${pluralize(input.contextResourceCount, 'data resource')} and ${input.contextSkillCount} ${pluralize(input.contextSkillCount, 'runnable skill')} across ${input.contextNamespaceCount} ${pluralize(input.contextNamespaceCount, 'namespace')}.`;
}
/** Renders the complete Context Tab content. */
function renderContextTab(input) {
  const capabilityBriefing = buildCapabilityBriefing(input);
  return b`
    <div class="tab-content ${e({ active: input.active })} flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs font-bold uppercase tracking-[0.18em] opacity-60"
            >Page Capabilities</span
          >
          <span class="text-[11px] opacity-55"
            >Operational briefing for what this page can expose to the bridge right now</span
          >
        </div>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="grid grid-cols-[minmax(240px,320px)_1fr] flex-1 min-h-0">
        <!-- Sidebar -->
        <div class="border-r border-base-300 bg-base-100 overflow-auto">
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">
              Page Identity
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">App</div>
                <div class="stat-value text-sm font-bold">${input.contextAppValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Scene</div>
                <div class="stat-value text-sm font-bold">${input.contextSceneValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Tab</div>
                <div class="stat-value text-sm font-bold">${input.contextTabValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Route</div>
                <div class="stat-value text-sm font-bold">${input.contextRouteValue}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50">
                Exposure Snapshot
              </div>
              <span class="badge badge-ghost badge-xs">${input.manifestStatus}</span>
            </div>
            <div class="text-[11px] opacity-55 mb-2">${capabilityBriefing}</div>
            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Namespaces</div>
                <div class="text-sm font-bold">${input.contextNamespaceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Data</div>
                <div class="text-sm font-bold">${input.contextResourceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Skills</div>
                <div class="text-sm font-bold">${input.contextSkillCount}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Business Domains
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Namespace groups the page has declared for agent-visible work.
            </div>
            <div id="contextNamespacesList">${input.contextNamespacesListHtml}</div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Available Data
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Structured payloads the page currently allows the bridge to read.
            </div>
            <div id="contextResourcesList" @click=${input.onResourceClick}>
              ${input.contextResourcesListHtml}
            </div>
          </div>
          <div class="p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Available Workflows
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Promptable actions grounded in this page's current data and tool surface.
            </div>
            <div id="contextSkillsList" @click=${input.onSkillClick}>
              ${input.contextSkillsListHtml}
            </div>
          </div>
        </div>
        <!-- Main -->
        <div class="bg-base-200 overflow-auto p-3 flex flex-col gap-3">
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="font-bold text-sm">Agent Briefing</div>
                  <p class="text-[11px] opacity-55">
                    Concrete summary of what an agent can inspect or invoke on this page.
                  </p>
                </div>
                <div class="flex gap-1.5 flex-wrap justify-end">
                  <span class="badge badge-ghost badge-sm">${input.contextAppValue}</span>
                  <span class="badge badge-ghost badge-sm">${input.contextSceneValue}</span>
                  <span class="badge badge-outline badge-sm">tab ${input.contextTabValue}</span>
                </div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-3 py-2">
                <div class="text-sm font-semibold">${capabilityBriefing}</div>
                <div class="text-xs opacity-60 mt-1">
                  Route ${input.contextRouteValue} is currently mapped to app
                  <strong>${input.contextAppValue}</strong> in scene
                  <strong>${input.contextSceneValue}</strong>.
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">Manifest Status</div>
                  <div class="text-sm font-semibold ${input.manifestStatusClass}">
                    ${input.manifestStatus}
                  </div>
                </div>
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">Filter Result</div>
                  <div class="text-sm font-semibold ${input.diffStatusClass}">
                    ${input.diffStatus}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Capability Filters</span>
                <span class="text-xs font-semibold ${input.diffStatusClass}"
                  >${input.diffStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Anything declared by the page but removed before agent exposure shows up here with
                the filter reason.
              </p>
              <div id="contextDiffOutput" class="flex flex-col gap-2">${input.diffOutput}</div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Raw Manifest</span>
                <span class="text-xs font-semibold ${input.manifestStatusClass}"
                  >${input.manifestStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Low-level manifest payload from the current tab. Useful for debugging, not the
                primary reading view.
              </p>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.manifestOutput}</pre
              >
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Selected Data Payload</span>
                <span class="text-xs font-semibold ${input.resourceStatusClass}"
                  >${input.resourceStatus}</span
                >
              </div>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.resourceOutput}</pre
              >
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Selected Skill Prompt</span>
                <span class="text-xs font-semibold ${input.skillStatusClass}"
                  >${input.skillStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Preview the exact prompt contract exposed by the page before an agent consumes it.
              </p>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.skillOutput}</pre
              >
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
//#endregion
//#region src/sidepanel-tool-test-controller.ts
/** Computes initial Tool Test state from a selection. */
function initializeToolTestState(selection) {
  return {
    toolTestTitle: `Tool Test · ${selection.label}`,
    toolTestSubtitle:
      selection.root === 'builtin'
        ? `Built-in tool: ${selection.toolName}`
        : `Context tool: ${selection.toolName}${selection.tabId != null ? ` · tab ${selection.tabId}` : ''}`,
    toolTestTabIdValue: selection.tabId != null ? String(selection.tabId) : '',
    toolTestTabIdDisabled: selection.root === 'page' && selection.tabId != null,
    toolTestSchemaOutput: formatJson(selection.inputSchema ?? {}),
    toolTestArgs: createArgsTemplate(selection.inputSchema),
    toolTestOutput: '(no output yet)',
    toolTestStatusText: 'Ready',
    toolTestStatusClass: 'text-xs font-semibold opacity-60',
  };
}
/** Returns reset state for args-related fields while preserving selection. */
function resetToolTestArgsState(inputSchema) {
  return {
    toolTestArgs: createArgsTemplate(inputSchema),
    toolTestOutput: '(no output yet)',
    toolTestStatusText: 'Ready',
    toolTestStatusClass: 'text-xs font-semibold opacity-60',
  };
}
//#endregion
//#region src/sidepanel-navigation.ts
/**
 * Navigation and iframe management utilities for the side panel.
 */
/** Normalizes a URL by prepending http:// if no scheme is present. */
function normalizeUrl(url) {
  return /^https?:\/\//.test(url) ? url : `http://${url}`;
}
/** Creates the bound message handler for iframe communication. */
function createBoundMessageHandler() {
  return (e) => {
    if (!e.data?.type) return;
    switch (e.data.type) {
      case 'sidepanel-action':
        if (e.data.action === 'open-opencode') tabsCreate({ url: 'opencode://v1/web?port=22338' });
        break;
    }
  };
}
/** Builds the loader iframe URL for embedding a target page. */
function buildLoaderUrl(currentUrl) {
  return runtimeGetUrl('loader.html') + '#' + currentUrl;
}
//#endregion
//#region src/sidepanel.css?url
var sidepanel_default = '/sidepanel.DVDqThPY.css';
//#endregion
//#region src/side-panel-app.ts
/**
 * Simple structured logger for side-panel debugging.
 * Prefixes all messages with [side-panel] for easy filtering.
 * Levels: log (default), warn, error.
 */
function spLog(message, level = 'log') {
  const prefix = '[side-panel]';
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
}
/** Minimal debounce utility for event handlers. */
function createDebounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, ms);
  };
}
function formatBuildTimeLabel(buildTime) {
  if (buildTime === 'dev') return '开发环境 / 未注入构建时间';
  const parsed = new Date(buildTime);
  if (Number.isNaN(parsed.getTime())) return buildTime;
  return parsed.toISOString().replace('.000Z', 'Z');
}
function parseOptionalQueryNumber(searchParams, name) {
  const value = searchParams.get(name);
  if (value == null) return;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : void 0;
}
/**
 * 读取 sidepanel URL query 绑定。
 * 这里只解析 launcher/fallback 约定的字段，避免把 runtime payload 语义掺进来。
 */
function readSidepanelUrlTabBinding() {
  const searchParams = new URLSearchParams(window.location.search);
  const boundTabId = parseOptionalQueryNumber(searchParams, 'boundTabId');
  const windowId = parseOptionalQueryNumber(searchParams, 'windowId');
  return {
    ...(boundTabId != null ? { boundTabId } : {}),
    ...(windowId != null ? { windowId } : {}),
  };
}
function readCurrentSidepanelSurface() {
  return readSidepanelSurface(window.location.search);
}
/**
 * 归一化 runtime 显式绑定。
 * 规则固定为 tabId > boundTabId，windowId 仅在存在时透传。
 */
function normalizeRuntimeExplicitTabBinding(input) {
  if (input == null) return {};
  return {
    ...(input.tabId != null
      ? { tabId: input.tabId }
      : input.boundTabId != null
        ? { tabId: input.boundTabId }
        : {}),
    ...(input.windowId != null ? { windowId: input.windowId } : {}),
  };
}
var customRules = i$4`
  /* tree indentation */
  .tree-indent-1 {
    padding-left: 1.5rem;
  }
  .tree-indent-2 {
    padding-left: 2.5rem;
  }
  .tree-indent-3 {
    padding-left: 3.5rem;
  }
  /* keep details/summary clean */
  details summary {
    list-style: none;
    cursor: pointer;
  }
  details summary::-webkit-details-marker {
    display: none;
  }
  /* iframe fill */
  .iframe-container iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  /* test panel toggle */
  .test-panel {
    display: none;
  }
  .test-panel.open {
    display: flex;
  }
  /* tab content visibility: override daisyUI's display:none */
  .tab-content {
    display: none;
  }
  .tab-content.active {
    display: flex;
  }
`;
var SidePanelApp = class SidePanelApp extends i$1 {
  constructor(..._args) {
    super(..._args);
    this._connected = false;
    this._refreshing = false;
    this._currentTabId = null;
    this._toolTreeResponse = null;
    this._currentFilter = '';
    this._currentToolTestSelection = null;
    this._currentRawContextManifest = null;
    this._currentEffectiveContextManifest = null;
    this._currentContextDebug = null;
    this._activeTab = 'tools';
    this._urlBarVisible = true;
    this._currentUrl = '';
    this._manifestStatus = '';
    this._manifestStatusClass = '';
    this._manifestOutput = '(manifest not loaded)';
    this._diffStatus = '';
    this._diffOutput = b``;
    this._resourceStatus = '';
    this._resourceOutput = '(select a resource to read)';
    this._skillStatus = '';
    this._skillOutput = '(select a skill to render its prompt)';
    this._contextAppValue = '-';
    this._contextSceneValue = '-';
    this._contextTabValue = '-';
    this._contextRouteValue = '-';
    this._contextNamespaceCount = '0';
    this._contextResourceCount = '0';
    this._contextSkillCount = '0';
    this._contextNamespacesListHtml = b``;
    this._contextResourcesListHtml = b``;
    this._contextSkillsListHtml = b``;
    this._toolTestArgs = '{}';
    this._toolTestOutput = '(no output yet)';
    this._toolTestStatusText = 'Idle';
    this._toolTestStatusClass = 'text-xs font-semibold opacity-60';
    this._toolTestRunning = false;
    this._toolTestSchemaOutput = '{}';
    this._toolTestTitle = 'Tool Test';
    this._toolTestSubtitle = 'Select a tool to run an RPC debug call.';
    this._toolTestTabIdValue = '';
    this._toolTestTabIdDisabled = false;
    this._feedbackBody = '';
    this._feedbackPriority = 'normal';
    this._feedbackCreateStatus = 'Idle';
    this._feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
    this._feedbackSnapshot = null;
    this._feedbackLoading = false;
    this._feedbackError = '';
    this._feedbackActionStateByAnnotationId = {};
    this._agentationInjecting = false;
    this._agentationInjectStatus = '';
    this._agentationInjectStatusClass = 'text-xs opacity-60';
    this._currentIframe = null;
    this._statusIntervalId = null;
    this._feedbackPollIntervalId = null;
    this._debouncedFilterInput = createDebounce((value) => {
      this._currentFilter = value;
    }, 150);
    this._urlTabBinding = readSidepanelUrlTabBinding();
    this._runtimeTabBinding = normalizeRuntimeExplicitTabBinding(this._urlTabBinding);
    this._surface = readCurrentSidepanelSurface();
    this._boundTabId = this._runtimeTabBinding.tabId;
    this._boundWindowId = this._runtimeTabBinding.windowId;
    this._diffStatusClass = 'text-xs font-semibold opacity-60';
    this._resourceStatusClass = 'text-xs font-semibold opacity-60';
    this._skillStatusClass = 'text-xs font-semibold opacity-60';
    this._boundMessageHandler = createBoundMessageHandler();
  }
  static {
    this.styles = [
      customRules,
      i$4`
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
    `,
    ];
  }
  connectedCallback() {
    super.connectedCallback();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = sidepanel_default;
    this.shadowRoot.appendChild(link);
    this._init();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this._boundMessageHandler);
    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }
    if (this._feedbackPollIntervalId) {
      clearInterval(this._feedbackPollIntervalId);
      this._feedbackPollIntervalId = null;
    }
    if (this._tabActivatedListener)
      chrome.tabs.onActivated.removeListener(this._tabActivatedListener);
    if (this._tabUpdatedListener) chrome.tabs.onUpdated.removeListener(this._tabUpdatedListener);
  }
  updated(changedProperties) {
    super.updated(changedProperties);
    if (changedProperties.has('_toolTreeResponse') || changedProperties.has('_currentFilter'))
      this.updateComplete.then(() => this._syncIndeterminateCheckboxes());
    if (changedProperties.has('_currentUrl')) this.updateComplete.then(() => this._manageIframe());
  }
  async _init() {
    await this._refreshStatus();
    this._statusIntervalId = setInterval(() => this._refreshStatus(), 5e3);
    this._feedbackPollIntervalId = setInterval(() => {
      if (this._activeTab === 'feedback') this._loadFeedbackSnapshot();
    }, 1e4);
    await this._loadPageTools();
    const launchUrl = await consumeLaunchUrlForSurface(this._surface);
    const url = launchUrl ? String(launchUrl) : 'http://127.0.0.1:22338/';
    this._navigateTo(url);
    this.updateComplete.then(() => this._manageIframe());
    this._tabActivatedListener = (activeInfo) => {
      if (this._boundTabId != null && activeInfo.tabId !== this._boundTabId) return;
      if (activeInfo.tabId !== this._currentTabId && this._activeTab === 'tools')
        this._loadPageTools();
      if (this._activeTab === 'context') this._loadContextManifest();
      if (this._activeTab === 'feedback') this._loadFeedbackSnapshot();
    };
    chrome.tabs.onActivated.addListener(this._tabActivatedListener);
    this._tabUpdatedListener = (_tabId, changeInfo) => {
      if (_tabId === this._currentTabId && changeInfo.status === 'complete')
        setTimeout(() => {
          if (this._activeTab === 'tools') this._loadPageTools();
          if (this._activeTab === 'context') this._loadContextManifest();
          if (this._activeTab === 'feedback') this._loadFeedbackSnapshot();
        }, 1e3);
    };
    chrome.tabs.onUpdated.addListener(this._tabUpdatedListener);
  }
  async _refreshStatus() {
    try {
      this._connected = (await sendRuntimeRequest(BRIDGE_METHODS.extensionStatusGet)).connected;
    } catch {
      this._connected = false;
    }
  }
  async _getCurrentTabId() {
    if (this._boundTabId != null) return this._boundTabId;
    const [tab] = await tabsQuery(
      this._boundWindowId != null
        ? {
            active: true,
            windowId: this._boundWindowId,
          }
        : {
            active: true,
            currentWindow: true,
          },
    );
    return tab?.id ?? null;
  }
  /**
   * 构建 feedback/runtime 请求使用的显式绑定。
   * 规则：
   * - 能确定 tabId 时优先带 tabId；
   * - 没有 tabId 但有 windowId 时只带 windowId；
   * - 两者都没有则不传绑定字段。
   */
  _buildRuntimeBindingPayload(tabId) {
    const runtimeBinding = normalizeRuntimeExplicitTabBinding({
      ...(tabId != null ? { tabId } : {}),
      ...(this._boundWindowId != null ? { windowId: this._boundWindowId } : {}),
    });
    return Object.keys(runtimeBinding).length > 0 ? runtimeBinding : void 0;
  }
  _syncIndeterminateCheckboxes() {
    const toolsPanel = this.shadowRoot.getElementById('toolsPanel');
    if (!toolsPanel) return;
    toolsPanel.querySelectorAll("input[data-indeterminate='true']").forEach((input) => {
      input.indeterminate = true;
    });
  }
  async _loadPageTools(forceRediscover = false) {
    this._currentTabId = await this._getCurrentTabId();
    try {
      const currentTabId = this._currentTabId;
      const shouldForceDiscover = forceRediscover && currentTabId != null;
      if (shouldForceDiscover)
        await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
          tabId: currentTabId,
        });
      this._toolTreeResponse = await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsTreeGet);
      const currentTabMissingFromTree =
        currentTabId != null &&
        !this._toolTreeResponse.tabs.some(
          (tab) => tab.tabId === currentTabId && tab.totalTools > 0,
        );
      if (!shouldForceDiscover && currentTabMissingFromTree)
        try {
          await sendRuntimeRequest(BRIDGE_METHODS.extensionPageToolsDiscover, {
            tabId: currentTabId,
          });
          this._toolTreeResponse = await sendRuntimeRequest(
            BRIDGE_METHODS.extensionPageToolsTreeGet,
          );
        } catch {}
    } catch (error) {
      this._toolTreeResponse = null;
    }
    this.requestUpdate();
  }
  async _updateScopeEnabled(input) {
    this._toolTreeResponse = await sendRuntimeRequest(
      BRIDGE_METHODS.extensionPageToolsSetEnabled,
      input,
    );
    this.requestUpdate();
    if (this._activeTab === 'context') await this._loadContextManifest();
  }
  /** 加载当前 tab 的上下文清单，填充左侧摘要 + 右侧详情面板 */
  async _loadContextManifest() {
    this._currentTabId = await this._getCurrentTabId();
    if (!this._currentTabId) {
      this._renderContextEmpty('No active tab found.', null, false);
      return;
    }
    this._manifestStatus = 'Loading...';
    this._manifestStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();
    try {
      const response = await sendRuntimeRequest(BRIDGE_METHODS.extensionContextManifestGet, {
        tabId: this._currentTabId,
      });
      const manifest = response.manifest;
      const rawManifest = response.rawManifest ?? response.manifest;
      this._currentContextDebug = response.debug ?? null;
      if (!manifest) {
        this._renderContextEmpty(
          'No page context manifest available for this tab.',
          this._currentTabId,
          false,
        );
        return;
      }
      this._currentRawContextManifest = rawManifest ?? manifest;
      this._currentEffectiveContextManifest = manifest;
      this._contextAppValue = manifest.app;
      this._contextSceneValue = manifest.scene;
      this._contextTabValue = String(this._currentTabId);
      this._contextRouteValue = manifest.route || '/';
      this._contextNamespaceCount = String(manifest.namespaces.length);
      this._contextResourceCount = String(manifest.resources.length);
      this._contextSkillCount = String(manifest.skills.length);
      this._contextNamespacesListHtml =
        manifest.namespaces.length > 0
          ? b`${manifest.namespaces.map((namespace) => renderContextNamespaceCard(namespace))}`
          : b`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No business domains declared.</p>
            </div>`;
      this._contextResourcesListHtml =
        manifest.resources.length > 0
          ? b`${manifest.resources.map((resource) => renderContextResourceCard(resource))}`
          : b`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No resources declared.</p>
            </div>`;
      this._contextSkillsListHtml =
        manifest.skills.length > 0
          ? b`${manifest.skills.map((skill) => renderContextSkillCard(skill))}`
          : b`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
              <p class="text-xs">No skills declared.</p>
            </div>`;
      this._renderContextDiff(rawManifest, manifest);
      this._manifestStatus = 'Loaded';
      this._manifestStatusClass = 'text-xs font-semibold text-success';
      this._manifestOutput = formatJson(manifest);
    } catch (error) {
      this._currentContextDebug = null;
      const message = error instanceof Error ? error.message : String(error);
      this._renderContextEmpty(message, this._currentTabId, true);
    }
  }
  /**
   * 清空所有 context 面板状态，显示占位消息。
   * 在无活跃 tab 或清单加载失败时调用。
   */
  _renderContextEmpty(message, currentTabId, isError) {
    this._contextAppValue = '-';
    this._contextSceneValue = '-';
    this._contextTabValue = currentTabId != null ? String(currentTabId) : '-';
    this._contextRouteValue = '-';
    this._contextNamespaceCount = '0';
    this._contextResourceCount = '0';
    this._contextSkillCount = '0';
    this._contextNamespacesListHtml = b`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._contextResourcesListHtml = b`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._contextSkillsListHtml = b`<div
      class="flex flex-col items-center justify-center p-4 text-base-content/40"
    >
      <p class="text-xs">${message}</p>
    </div>`;
    this._manifestStatus = message;
    this._manifestStatusClass =
      `text-xs font-semibold ${isError ? 'text-error' : 'opacity-60'}`.trim();
    this._manifestOutput = isError ? formatJson({ error: message }) : '(manifest not loaded)';
    this._diffStatus = 'Idle';
    this._diffStatusClass = 'text-xs font-semibold opacity-60';
    this._diffOutput = b`<div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <p class="text-xs opacity-60">(manifest diff not available)</p>
    </div>`;
    this._resourceStatus = 'Idle';
    this._resourceStatusClass = 'text-xs font-semibold opacity-60';
    this._resourceOutput = '(select a data card to inspect its payload)';
    this._skillStatus = 'Idle';
    this._skillStatusClass = 'text-xs font-semibold opacity-60';
    this._skillOutput = '(select a skill card to preview its prompt)';
    this.requestUpdate();
  }
  /**
   * 构建原始清单与过滤后清单的 diff 卡片（隐藏项 + 裁剪工具）。
   */
  _renderContextDiff(rawManifest, effectiveManifest) {
    const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
    const hasDiff =
      diff.hiddenNamespaces.length > 0 ||
      diff.hiddenResources.length > 0 ||
      diff.hiddenSkills.length > 0 ||
      diff.sceneChanged;
    this._diffStatus = hasDiff ? 'Diff detected' : 'No diff';
    this._diffStatusClass =
      `text-xs font-semibold ${hasDiff ? 'text-success' : 'opacity-60'}`.trim();
    const debug = this._currentContextDebug;
    this._diffOutput = b`
      ${this._renderDiffCard(
        'Namespaces',
        diff.rawNamespaces,
        diff.effectiveNamespaces,
        debug?.hiddenNamespaces ??
          diff.hiddenNamespaces.map((id) => ({
            id,
            reason: 'unknown',
          })),
      )}
      ${this._renderDiffCard(
        'Resources',
        diff.rawResources,
        diff.effectiveResources,
        debug?.hiddenResources ??
          diff.hiddenResources.map((id) => ({
            id,
            reason: 'unknown',
          })),
      )}
      ${this._renderDiffCard(
        'Skills',
        diff.rawSkills,
        diff.effectiveSkills,
        debug?.hiddenSkills ??
          diff.hiddenSkills.map((id) => ({
            id,
            reason: 'unknown',
          })),
      )}
      ${this._renderTrimmedToolsCard(debug)}
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Scene</h4>
        <p class="text-xs opacity-70">
          ${diff.sceneChanged ? 'Scene changed between raw and effective manifest.' : 'Scene is unchanged.'}
        </p>
      </div>
    `;
  }
  /**
   * 渲染单个 diff 分类卡片（Namespaces / Resources / Skills）。
   */
  _renderDiffCard(title, rawCount, effectiveCount, hiddenItems) {
    return b`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">${title}</h4>
        <p class="text-xs opacity-70">Raw: ${rawCount} · Effective: ${effectiveCount}</p>
        ${
          hiddenItems.length > 0
            ? b`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
              ${hiddenItems.map(
                (item) => b`<li class="break-words">
                    <strong>${item.id}</strong> · ${formatReason(item.reason)}
                  </li>`,
              )}
            </ul>`
            : b`<p class="text-xs opacity-50 mt-1">No hidden items.</p>`
        }
      </div>
    `;
  }
  /** 渲染 skill 工具裁剪卡片（被过滤掉的推荐工具列表） */
  _renderTrimmedToolsCard(debug) {
    const trimmed = debug?.trimmedSkillTools ?? [];
    return b`
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Skill Tool Trimming</h4>
        ${
          trimmed.length > 0
            ? b`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
              ${trimmed.flatMap((entry) =>
                entry.removedTools.map(
                  (item) => b`<li class="break-words">
                      <strong>${entry.skillId}</strong> · ${item.id} · ${formatReason(item.reason)}
                    </li>`,
                ),
              )}
            </ul>`
            : b`<p class="text-xs opacity-50 mt-1">
              No skill tool recommendations were trimmed.
            </p>`
        }
      </div>
    `;
  }
  /** 通过 RPC 读取指定资源 payload，填充右侧 Data Payload 卡片 */
  async _loadContextResource(resourceId) {
    if (!this._currentTabId) return;
    this._resourceStatus = `Reading ${resourceId}...`;
    this._resourceStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();
    try {
      const resource = await sendRuntimeRequest(BRIDGE_METHODS.extensionContextResourceRead, {
        tabId: this._currentTabId,
        resourceId,
      });
      this._resourceStatus = `Loaded ${resourceId}`;
      this._resourceStatusClass = 'text-xs font-semibold text-success';
      this._resourceOutput = resource.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._resourceStatus = message;
      this._resourceStatusClass = 'text-xs font-semibold text-error';
      this._resourceOutput = formatJson({ error: message });
    }
  }
  /** 通过 RPC 获取 skill 的 prompt 合同文本，填充右侧 Skill Prompt 卡片 */
  async _loadContextSkillPrompt(skillId) {
    if (!this._currentTabId) return;
    this._skillStatus = `Rendering ${skillId}...`;
    this._skillStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();
    try {
      const response = await sendRuntimeRequest(BRIDGE_METHODS.extensionContextSkillGet, {
        tabId: this._currentTabId,
        skillId,
        input: { goal: 'Explain how the agent should use this business skill safely.' },
      });
      this._skillStatus = response.prompt ? `Loaded ${skillId}` : `Skill ${skillId} unavailable`;
      this._skillStatusClass = `text-xs font-semibold ${response.prompt ? 'text-success' : 'text-error'}`;
      this._skillOutput = response.prompt
        ? formatJson(response.prompt)
        : formatJson({ error: 'Prompt unavailable' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._skillStatus = message;
      this._skillStatusClass = 'text-xs font-semibold text-error';
      this._skillOutput = formatJson({ error: message });
    }
  }
  async _loadFeedbackSnapshot() {
    this._currentTabId = await this._getCurrentTabId();
    this._feedbackLoading = true;
    this._feedbackError = '';
    this.requestUpdate();
    try {
      const runtimeBinding = this._buildRuntimeBindingPayload(this._currentTabId);
      this._feedbackSnapshot = await sendRuntimeRequest(
        BRIDGE_METHODS.extensionFeedbackStateSnapshot,
        runtimeBinding,
      );
      this._feedbackActionStateByAnnotationId = reconcileFeedbackActionStates(
        this._feedbackActionStateByAnnotationId,
        this._feedbackSnapshot.annotations,
      );
      this._feedbackCreateStatus = 'Snapshot loaded';
      this._feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
    } catch (error) {
      this._feedbackError = error instanceof Error ? error.message : String(error);
      this._feedbackSnapshot = null;
    } finally {
      this._feedbackLoading = false;
    }
  }
  async _submitFeedback() {
    const body = this._feedbackBody.trim();
    if (!body) {
      this._feedbackCreateStatus = 'Please enter feedback content';
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-error';
      return;
    }
    this._feedbackCreateStatus = 'Submitting...';
    this._feedbackCreateStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();
    try {
      this._currentTabId = await this._getCurrentTabId();
      const runtimeBinding = this._buildRuntimeBindingPayload(this._currentTabId);
      await sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationCreate, {
        body,
        priority: this._feedbackPriority,
        ...(runtimeBinding ?? {}),
      });
      this._feedbackBody = '';
      this._feedbackCreateStatus = 'Created';
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-success';
      await this._loadFeedbackSnapshot();
    } catch (error) {
      this._feedbackCreateStatus = error instanceof Error ? error.message : String(error);
      this._feedbackCreateStatusClass = 'text-xs font-semibold text-error';
    }
  }
  _readFeedbackActionState(annotationId) {
    return readFeedbackActionState(this._feedbackActionStateByAnnotationId, annotationId);
  }
  _updateFeedbackActionState(annotationId, updater) {
    this._feedbackActionStateByAnnotationId = updateFeedbackActionStates(
      this._feedbackActionStateByAnnotationId,
      annotationId,
      updater,
    );
  }
  _setFeedbackActionMode(annotationId, mode) {
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      mode: current.mode === mode ? null : mode,
      error: '',
      success: '',
    }));
  }
  _handleFeedbackActionInput(annotationId, field, event) {
    const value = event.target.value;
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      [field]: value,
      error: '',
      success: '',
    }));
  }
  async _runFeedbackMutation(annotationId, request, successMessage, onSuccess) {
    this._updateFeedbackActionState(annotationId, (current) => ({
      ...current,
      submitting: true,
      error: '',
      success: '',
    }));
    try {
      await request();
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...onSuccess(current),
        submitting: false,
        error: '',
        success: successMessage,
      }));
      await this._loadFeedbackSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...current,
        submitting: false,
        error: message,
      }));
    }
  }
  async _claimFeedbackAnnotation(annotationId) {
    await this._runFeedbackMutation(
      annotationId,
      () => sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationClaim, { annotationId }),
      'Claimed',
      (state) => ({
        ...state,
        mode: null,
      }),
    );
  }
  async _replyFeedbackAnnotation(annotationId) {
    const body = this._readFeedbackActionState(annotationId).replyBody.trim();
    if (!body) {
      this._updateFeedbackActionState(annotationId, (current) => ({
        ...current,
        error: 'Reply content cannot be empty',
      }));
      return;
    }
    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationReply, {
          annotationId,
          body,
        }),
      'Reply submitted',
      (current) => ({
        ...current,
        mode: null,
        replyBody: '',
      }),
    );
  }
  async _resolveFeedbackAnnotation(annotationId) {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationResolve, {
          annotationId,
          resolution: state.resolveNote.trim() || void 0,
        }),
      'Marked as resolved',
      (current) => ({
        ...current,
        mode: null,
        resolveNote: '',
      }),
    );
  }
  async _dismissFeedbackAnnotation(annotationId) {
    const state = this._readFeedbackActionState(annotationId);
    await this._runFeedbackMutation(
      annotationId,
      () =>
        sendRuntimeRequest(BRIDGE_METHODS.extensionFeedbackAnnotationDismiss, {
          annotationId,
          dismissReason: state.dismissReason.trim() || void 0,
        }),
      'Dismissed',
      (current) => ({
        ...current,
        mode: null,
        dismissReason: '',
      }),
    );
  }
  _openToolTestPanel(selection) {
    this._currentToolTestSelection = selection;
    const init = initializeToolTestState(selection);
    this._toolTestTitle = init.toolTestTitle;
    this._toolTestSubtitle = init.toolTestSubtitle;
    this._toolTestTabIdValue = init.toolTestTabIdValue;
    this._toolTestTabIdDisabled = init.toolTestTabIdDisabled;
    this._toolTestSchemaOutput = init.toolTestSchemaOutput;
    this._toolTestArgs = init.toolTestArgs;
    this._toolTestOutput = init.toolTestOutput;
    this._toolTestStatusText = init.toolTestStatusText;
    this._toolTestStatusClass = init.toolTestStatusClass;
    this.requestUpdate();
  }
  _closeToolTestPanel() {
    this._currentToolTestSelection = null;
    this.requestUpdate();
  }
  async _runToolDebugCall() {
    if (!this._currentToolTestSelection) return;
    let parsedArgs;
    try {
      const raw = this._toolTestArgs.trim() || '{}';
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('RPC args must be a JSON object');
      parsedArgs = parsed;
    } catch (error) {
      this._toolTestStatusText = error instanceof Error ? error.message : String(error);
      this._toolTestStatusClass = 'text-xs font-semibold text-error';
      this._toolTestOutput = '(invalid JSON args)';
      return;
    }
    this._toolTestRunning = true;
    this._toolTestStatusText = 'Running...';
    this._toolTestStatusClass = 'text-xs font-semibold opacity-60';
    this.requestUpdate();
    try {
      const tabId = this._toolTestTabIdValue ? Number(this._toolTestTabIdValue) : void 0;
      const response = await sendRuntimeRequest(BRIDGE_METHODS.extensionToolDebugCall, {
        toolName: this._currentToolTestSelection.toolName,
        tabId,
        args: parsedArgs,
      });
      this._toolTestStatusText = response.ok ? 'Success' : 'Failed';
      this._toolTestStatusClass = `text-xs font-semibold ${response.ok ? 'text-success' : 'text-error'}`;
      this._toolTestOutput = formatJson(
        response.ok ? (response.result ?? {}) : { error: response.error ?? 'Unknown error' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._toolTestStatusText = message;
      this._toolTestStatusClass = 'text-xs font-semibold text-error';
      this._toolTestOutput = formatJson({ error: message });
    } finally {
      this._toolTestRunning = false;
    }
  }
  _resetToolTestArgs() {
    const reset = resetToolTestArgsState(this._currentToolTestSelection?.inputSchema);
    if (reset.toolTestArgs !== void 0) this._toolTestArgs = reset.toolTestArgs;
    if (reset.toolTestOutput !== void 0) this._toolTestOutput = reset.toolTestOutput;
    if (reset.toolTestStatusText !== void 0) this._toolTestStatusText = reset.toolTestStatusText;
    if (reset.toolTestStatusClass !== void 0) this._toolTestStatusClass = reset.toolTestStatusClass;
  }
  _navigateTo(url) {
    this._currentUrl = normalizeUrl(url);
    this._urlBarVisible = true;
  }
  _manageIframe() {
    const container = this._iframeContainer ?? this.shadowRoot?.querySelector('#iframeContainer');
    if (!container) {
      spLog('_manageIframe: #iframeContainer not found in shadow DOM');
      return;
    }
    window.removeEventListener('message', this._boundMessageHandler);
    this._currentIframe?.remove();
    this._currentIframe = null;
    const loaderUrl = buildLoaderUrl(this._currentUrl);
    this._currentIframe = document.createElement('iframe');
    this._currentIframe.src = loaderUrl;
    this._currentIframe.allow = 'clipboard-read; clipboard-write';
    this._urlBarVisible = false;
    window.addEventListener('message', this._boundMessageHandler);
    container.appendChild(this._currentIframe);
  }
  _handleTabClick(tab) {
    console.log(
      '[side-panel] _handleTabClick called with:',
      tab,
      'current _activeTab:',
      this._activeTab,
    );
    this._activeTab = tab;
    console.log('[side-panel] _activeTab set to:', this._activeTab, 'about to requestUpdate');
    this.requestUpdate();
    console.log('[side-panel] requestUpdate done');
    if (tab === 'tools') this._loadPageTools();
    else if (tab === 'context') this._loadContextManifest();
    else if (tab === 'feedback') this._loadFeedbackSnapshot();
  }
  _handleGoClick() {
    const input = this.shadowRoot.querySelector('#urlInput');
    if (input) {
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }
  _handleUrlKeydown(event) {
    if (event.key === 'Enter') {
      const input = event.target;
      this._navigateTo(input.value.trim());
      this.updateComplete.then(() => this._manageIframe());
    }
  }
  async _handleReconnect() {
    if (this._refreshing) return;
    this._refreshing = true;
    this.requestUpdate();
    try {
      await sendRuntimeRequest(BRIDGE_METHODS.extensionReconnect);
    } catch (error) {
      spLog(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setTimeout(() => {
        this._refreshing = false;
        this._refreshStatus();
        this.requestUpdate();
      }, 800);
    }
  }
  async _handleInjectAgentation() {
    if (this._agentationInjecting) return;
    this._agentationInjecting = true;
    this._agentationInjectStatus = 'Injecting...';
    this._agentationInjectStatusClass = 'text-xs opacity-60';
    this.requestUpdate();
    try {
      const tabId = await this._getCurrentTabId();
      if (tabId == null) throw new Error('No active tab');
      await sendRuntimeRequest(BRIDGE_METHODS.extensionAgentationMainEnsure, { tabId });
      this._agentationInjectStatus = 'Injected';
      this._agentationInjectStatusClass = 'text-xs text-success';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._agentationInjectStatus = message;
      this._agentationInjectStatusClass = 'text-xs text-error';
      spLog(`Agentation inject failed: ${message}`, 'error');
    } finally {
      this._agentationInjecting = false;
      this.requestUpdate();
    }
  }
  _handleOpenTab() {
    const url = this.shadowRoot.querySelector('#urlInput')?.value.trim();
    if (url) tabsCreate({ url });
  }
  _handleToolsFilterInput(event) {
    const input = event.target;
    this._debouncedFilterInput(input.value.trim().toLowerCase());
  }
  _handleToolsPanelChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
    const { root, scope, tabId, namespace, instanceId, toolName } = target.dataset;
    if (!scope || !tabId) return;
    const resolvedRoot = root === 'builtin' || scope === 'builtin' ? 'builtin' : 'page';
    this._updateScopeEnabled({
      root: resolvedRoot,
      tabId: resolvedRoot === 'builtin' ? void 0 : Number(tabId),
      namespace,
      instanceId,
      toolName,
      enabled: target.checked,
    });
  }
  _handleToolsPanelClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'test-tool') return;
    this._openToolTestPanel({
      root: target.dataset.root ?? 'page',
      toolName: target.dataset.toolName ?? '',
      label: target.dataset.label ?? target.dataset.toolName ?? 'Tool',
      tabId: target.dataset.tabId ? Number(target.dataset.tabId) : void 0,
      inputSchema: target.dataset.schema ? safeParseJson(target.dataset.schema) : {},
    });
  }
  /** 响应侧栏 "Inspect Payload" 按钮点击，委托给 _loadContextResource */
  _handleContextResourceClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'read-resource') return;
    const resourceId = target.dataset.resourceId;
    if (resourceId) this._loadContextResource(resourceId);
  }
  /** 响应侧栏 "Inspect Skill" 按钮点击，委托给 _loadContextSkillPrompt */
  _handleContextSkillClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.dataset.action !== 'preview-skill') return;
    const skillId = target.dataset.skillId;
    if (skillId) this._loadContextSkillPrompt(skillId);
  }
  _handleToolTestArgsInput(event) {
    this._toolTestArgs = event.target.value;
  }
  _handleToolTestTabIdInput(event) {
    this._toolTestTabIdValue = event.target.value;
  }
  _handleFeedbackBodyInput(event) {
    this._feedbackBody = event.target.value;
  }
  _handleFeedbackPriorityChange(event) {
    this._feedbackPriority = event.target.value;
  }
  _renderToolsTreeContent() {
    if (!this._toolTreeResponse) return renderToolsEmpty('No tools loaded.');
    const filteredTabs = this._toolTreeResponse.tabs
      .map((tab) => filterTab(tab, this._currentFilter))
      .filter((tab) => tab !== null);
    if (filteredTabs.length === 0) {
      const builtinTools = filterBuiltins(this._toolTreeResponse.builtins, this._currentFilter);
      if (builtinTools.totalTools === 0)
        return renderToolsEmpty(
          this._currentFilter
            ? `No tools match '${this._currentFilter}'.`
            : 'No tools discovered yet.',
        );
      return renderBuiltinsNode(builtinTools);
    }
    const builtinTools = filterBuiltins(this._toolTreeResponse.builtins, this._currentFilter);
    return b`
      ${builtinTools.totalTools > 0 ? renderBuiltinsNode(builtinTools) : A}
      ${filteredTabs.map((tab) => renderTabNode(tab))}
    `;
  }
  render() {
    try {
      return this._renderContent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spLog(`render error: ${message}`, 'error');
      return b`
        <div class="flex flex-col items-center justify-center flex-1 p-4 text-error">
          <p class="text-sm font-semibold">Render Error</p>
          <p class="text-xs mt-1 opacity-70 break-all">${message}</p>
          <button class="btn btn-xs btn-ghost mt-2" @click=${() => this.requestUpdate()}>
            Retry
          </button>
        </div>
      `;
    }
  }
  _renderContent() {
    spLog(`render() called, _activeTab = ${this._activeTab}`);
    const buildTimeText = `构建时间：${formatBuildTimeLabel(this.getAttribute('data-build-time')?.trim() || 'dev')}`;
    const toolsCount = this._toolTreeResponse
      ? `(${this._toolTreeResponse.enabledTools}/${this._toolTreeResponse.totalTools} enabled) · ${buildTimeText}`
      : buildTimeText;
    return b`
      <!-- Header: status-dot (clickable refresh) / title / icon-nav (right) -->
      <div
        class="flex items-center gap-2 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0"
      >
        <button
          class="w-4 h-4 rounded-full shrink-0 flex items-center justify-center ${this._refreshing ? 'bg-base-300' : this._connected ? 'bg-success' : 'bg-error'} hover:opacity-80 transition-all duration-200 cursor-pointer border-none p-0 overflow-hidden"
          @click=${this._handleReconnect}
          title="${this._refreshing ? 'Refreshing...' : 'Click to refresh'}"
        >
          <svg
            class="w-3 h-3 text-white transition-opacity duration-200 ${this._refreshing ? 'animate-spin opacity-100' : 'opacity-0'}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
        <span class="font-semibold text-sm truncate">Page Context Bridge</span>
        <button
          class="btn btn-xs btn-ghost ${this._agentationInjecting ? 'loading' : ''}"
          @click=${() => void this._handleInjectAgentation()}
          ?disabled=${this._agentationInjecting}
          title=${this._agentationInjectStatus || 'Inject Agentation into the active tab'}
        >
          Inject Agentation
        </button>
        ${
          this._agentationInjectStatus
            ? b`<span
              class=${this._agentationInjectStatusClass}
              title=${this._agentationInjectStatus}
              >${this._agentationInjectStatus}</span
            >`
            : A
        }
        <div role="tablist" class="tabs tabs-boxed ml-auto bg-transparent border-none gap-0.5">
          <button
            role="tab"
            class="tab tab-xs px-2 ${e({ 'tab-active': this._activeTab === 'tools' })}"
            @click=${() => this._handleTabClick('tools')}
            title="Tools"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
              />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${e({ 'tab-active': this._activeTab === 'context' })}"
            @click=${() => this._handleTabClick('context')}
            title="Context"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${e({ 'tab-active': this._activeTab === 'feedback' })}"
            @click=${() => this._handleTabClick('feedback')}
            title="Feedback"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            role="tab"
            class="tab tab-xs px-2 ${e({ 'tab-active': this._activeTab === 'diagnosis' })}"
            @click=${() => this._handleTabClick('diagnosis')}
            title="Diagnosis"
          >
            <svg
              class="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </button>
        </div>
      </div>

      ${renderToolsTab({
        active: this._activeTab === 'tools',
        toolsCount,
        currentFilter: this._currentFilter,
        currentToolTestSelection: this._currentToolTestSelection,
        toolTestTitle: this._toolTestTitle,
        toolTestSubtitle: this._toolTestSubtitle,
        toolTestTabIdValue: this._toolTestTabIdValue,
        toolTestTabIdDisabled: this._toolTestTabIdDisabled,
        toolTestSchemaOutput: this._toolTestSchemaOutput,
        toolTestArgs: this._toolTestArgs,
        toolTestOutput: this._toolTestOutput,
        toolTestStatusText: this._toolTestStatusText,
        toolTestStatusClass: this._toolTestStatusClass,
        toolTestRunning: this._toolTestRunning,
        renderToolsTreeContent: () => this._renderToolsTreeContent(),
        onRefresh: () => void this._loadPageTools(true),
        onFilterInput: this._handleToolsFilterInput,
        onPanelChange: this._handleToolsPanelChange,
        onPanelClick: this._handleToolsPanelClick,
        onCloseToolTestPanel: this._closeToolTestPanel,
        onToolTestTabIdInput: this._handleToolTestTabIdInput,
        onToolTestArgsInput: this._handleToolTestArgsInput,
        onResetToolTestArgs: this._resetToolTestArgs,
        onRunToolDebugCall: () => void this._runToolDebugCall(),
      })}
      ${renderContextTab({
        active: this._activeTab === 'context',
        contextAppValue: this._contextAppValue,
        contextSceneValue: this._contextSceneValue,
        contextTabValue: this._contextTabValue,
        contextRouteValue: this._contextRouteValue,
        contextNamespaceCount: this._contextNamespaceCount,
        contextResourceCount: this._contextResourceCount,
        contextSkillCount: this._contextSkillCount,
        contextNamespacesListHtml: this._contextNamespacesListHtml,
        contextResourcesListHtml: this._contextResourcesListHtml,
        contextSkillsListHtml: this._contextSkillsListHtml,
        manifestStatus: this._manifestStatus,
        manifestStatusClass: this._manifestStatusClass,
        manifestOutput: this._manifestOutput,
        diffStatus: this._diffStatus,
        diffStatusClass: this._diffStatusClass,
        diffOutput: this._diffOutput,
        resourceStatus: this._resourceStatus,
        resourceStatusClass: this._resourceStatusClass,
        resourceOutput: this._resourceOutput,
        skillStatus: this._skillStatus,
        skillStatusClass: this._skillStatusClass,
        skillOutput: this._skillOutput,
        onRefresh: () => void this._loadContextManifest(),
        onResourceClick: this._handleContextResourceClick,
        onSkillClick: this._handleContextSkillClick,
      })}

      <!-- Feedback Tab -->
      ${
        this._activeTab === 'feedback'
          ? renderFeedbackTab({
              snapshot: this._feedbackSnapshot,
              loading: this._feedbackLoading,
              error: this._feedbackError,
              body: this._feedbackBody,
              priority: this._feedbackPriority,
              createStatus: this._feedbackCreateStatus,
              createStatusClass: this._feedbackCreateStatusClass,
              readActionState: (annotationId) => this._readFeedbackActionState(annotationId),
              onRefresh: () => void this._loadFeedbackSnapshot(),
              onBodyInput: this._handleFeedbackBodyInput,
              onPriorityChange: this._handleFeedbackPriorityChange,
              onSubmit: () => void this._submitFeedback(),
              onToggleMode: (annotationId, mode) => this._setFeedbackActionMode(annotationId, mode),
              onActionInput: (annotationId, field, event) =>
                this._handleFeedbackActionInput(annotationId, field, event),
              onClaim: (annotationId) => void this._claimFeedbackAnnotation(annotationId),
              onReply: (annotationId) => void this._replyFeedbackAnnotation(annotationId),
              onResolve: (annotationId) => void this._resolveFeedbackAnnotation(annotationId),
              onDismiss: (annotationId) => void this._dismissFeedbackAnnotation(annotationId),
            })
          : b`<div class="tab-content flex flex-col flex-1 min-h-0"></div>`
      }

      <!-- Diagnosis Tab -->
      <div
        class="tab-content ${e({ active: this._activeTab === 'diagnosis' })} flex flex-col flex-1 min-h-0"
      >
        ${n(
          this._urlBarVisible,
          () => b`
            <div
              class="flex items-center gap-1.5 px-3 py-1.5 bg-base-100 border-b border-base-300 shrink-0"
            >
              <input
                type="text"
                id="urlInput"
                .value=${this._currentUrl}
                @keydown=${this._handleUrlKeydown}
                placeholder="Enter URL to embed..."
                class="input input-sm input-bordered flex-1 font-mono"
              />
              <button class="btn btn-sm btn-primary" @click=${this._handleGoClick}>Go</button>
            </div>
          `,
        )}
        <div class="iframe-container flex-1 relative bg-base-100" id="iframeContainer"></div>
      </div>
    `;
  }
};
__decorate([r()], SidePanelApp.prototype, '_connected', void 0);
__decorate([r()], SidePanelApp.prototype, '_refreshing', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentTabId', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTreeResponse', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentFilter', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentToolTestSelection', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentRawContextManifest', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentEffectiveContextManifest', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentContextDebug', void 0);
__decorate([r()], SidePanelApp.prototype, '_activeTab', void 0);
__decorate([r()], SidePanelApp.prototype, '_urlBarVisible', void 0);
__decorate([r()], SidePanelApp.prototype, '_currentUrl', void 0);
__decorate([r()], SidePanelApp.prototype, '_manifestStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_manifestStatusClass', void 0);
__decorate([r()], SidePanelApp.prototype, '_manifestOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_diffStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_diffOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_resourceStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_resourceOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_skillStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_skillOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextAppValue', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextSceneValue', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextTabValue', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextRouteValue', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextNamespaceCount', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextResourceCount', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextSkillCount', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextNamespacesListHtml', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextResourcesListHtml', void 0);
__decorate([r()], SidePanelApp.prototype, '_contextSkillsListHtml', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestArgs', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestStatusText', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestStatusClass', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestRunning', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestSchemaOutput', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestTitle', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestSubtitle', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestTabIdValue', void 0);
__decorate([r()], SidePanelApp.prototype, '_toolTestTabIdDisabled', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackBody', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackPriority', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackCreateStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackCreateStatusClass', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackSnapshot', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackLoading', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackError', void 0);
__decorate([r()], SidePanelApp.prototype, '_feedbackActionStateByAnnotationId', void 0);
__decorate([r()], SidePanelApp.prototype, '_agentationInjecting', void 0);
__decorate([r()], SidePanelApp.prototype, '_agentationInjectStatus', void 0);
__decorate([r()], SidePanelApp.prototype, '_agentationInjectStatusClass', void 0);
__decorate([e$2('#iframeContainer')], SidePanelApp.prototype, '_iframeContainer', void 0);
__decorate([r()], SidePanelApp.prototype, '_diffStatusClass', void 0);
__decorate([r()], SidePanelApp.prototype, '_resourceStatusClass', void 0);
__decorate([r()], SidePanelApp.prototype, '_skillStatusClass', void 0);
SidePanelApp = __decorate([t$1('side-panel-app')], SidePanelApp);
//#endregion
