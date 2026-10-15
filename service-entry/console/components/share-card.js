// ShareCard (07 §4.4, §6.10, 05 §13.4): the one-time display of a new key.
//
// It is built from the create or rotate response `{ key, secret, share }`.
// The secret lives only in this component's props and state: the parent holds
// the response until the card closes and then drops it, and nothing here is
// written to storage, the URL or a toast. Closing needs the "I have saved the
// key" box, Esc and a backdrop click do nothing before that, and once closed
// the card cannot be reopened (the response is gone, the server never shows
// the secret again).
//
// data = { kind: "create" | "rotate" | "legacy", key, secret, share?, overlapSeconds? }
//   share = { openaiBase, anthropicBase, portalUrl?, recommendedModel?, snippetCurl? }

import { createFormatters } from "../lib/format.js";
import { createI18n, tk } from "../lib/i18n.js";
import { inviteText, limitsSummary, portalLink } from "../lib/access-model.js";
import { useServices } from "../ui/context.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useMemo, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { CodeBlock, useCopy } from "./code-block.js";
import { Dialog } from "./dialog.js";
import { QrCode } from "./qr-code.js";

// A read-only value with its own copy button.
function CopyRow({ label, value, testid, autofocus = false }) {
  const { t } = useT();
  const id = useId();
  const [state, copy] = useCopy();
  return html`<div class="field" data-testid=${testid}>
    <label class="field-label" for=${id}>${label}</label>
    <div class="row-nowrap">
      <input id=${id} class="input mono grow" readonly value=${value} onFocus=${(event) => event.currentTarget.select()} data-testid=${`${testid}.value`} />
      <${Button} onClick=${() => copy(value)} data-autofocus=${autofocus ? "" : undefined} testid=${`${testid}.copy`}>${state === "copied" ? t("common.copied") : t("common.copy")}<//>
    </div>
    ${state === "failed" ? html`<div class="field-hint text-danger" role="status">${t("common.copyFailed")}</div>` : null}
  </div>`;
}

// The invite message, in this console's language or the other one (its catalog is fetched on first use).
function InviteBlock({ data }) {
  const services = useServices();
  const { t, locale } = useT();
  const fmt = useFormat();
  const [other, setOther] = useState(null);
  const [lang, setLang] = useState("current");
  const [failed, setFailed] = useState(false);
  const [state, copy] = useCopy();
  const target = locale === "zh-CN" ? "en-US" : "zh-CN";

  useEffect(() => {
    if (lang !== "other" || other || failed) return undefined;
    let alive = true;
    services.api.get(`/c/${services.bootstrap?.buildId}/i18n/${target}.json`).then(
      (catalog) => alive && setOther({ i18n: createI18n({ locale: target, catalog }), fmt: createFormatters(target) }),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [lang, other, failed]);

  const active = lang === "other" && other ? other : { i18n: services.i18n, fmt };
  const text = useMemo(() => inviteText(active.i18n, {
    holder: data.key?.holder,
    share: data.share,
    secret: data.secret,
    expiresAt: data.key?.expiresAt,
    limits: data.key?.limits,
    fmt: active.fmt,
  }), [active, data]);

  return html`<section class="stack-sm" aria-labelledby="share-invite-title" data-testid="share-card.invite">
    <div class="row">
      <h3 id="share-invite-title" class="card-title grow">${t("access.share.invite")}</h3>
      <div class="sf-seg" role="group" aria-label=${t("access.share.inviteLang")}>
        <button type="button" class="sf-seg-opt" aria-pressed=${lang === "current"} onClick=${() => setLang("current")} data-testid="share-card.lang-current">${t(locale === "zh-CN" ? "access.share.lang.zh" : "access.share.lang.en")}</button>
        <button type="button" class="sf-seg-opt" aria-pressed=${lang === "other"} onClick=${() => setLang("other")} data-testid="share-card.lang-other">${t(locale === "zh-CN" ? "access.share.lang.en" : "access.share.lang.zh")}</button>
      </div>
    </div>
    ${failed ? html`<p class="field-error" role="alert">${t("access.share.langFailed")}</p>` : null}
    <pre class="share-invite" tabindex="0" data-user-content data-testid="share-card.invite-text">${text}</pre>
    <div class="row">
      <${Button} onClick=${() => copy(text)} testid="share-card.copy-invite">${state === "copied" ? t("common.copied") : t("access.share.copyInvite")}<//>
    </div>
  </section>`;
}

export function ShareCard({ data, onClose }) {
  const { t } = useT();
  const fmt = useFormat();
  const [saved, setSaved] = useState(false);
  const share = data?.share || null;
  const key = data?.key || {};
  const link = share?.portalUrl ? portalLink(share.portalUrl, data.secret) : "";
  const summary = limitsSummary({ t }, key.limits);
  const title = data?.kind === "rotate" ? t("access.share.titleRotate") : t("access.share.title");
  const done = () => onClose?.();

  const footer = html`
    <label class="check"><input type="checkbox" checked=${saved} onChange=${(event) => setSaved(event.currentTarget.checked)} data-testid="share-card.saved" />${t("access.share.saved")}</label>
    <span class="spacer"></span>
    <${Button} variant="primary" disabled=${!saved} onClick=${done} testid="share-card.close">${t("common.close")}<//>`;

  return html`<${Dialog} open title=${title} dismissible=${saved} onClose=${done} footer=${footer} testid="share-card.root">
    <div class="stack" data-testid="share-card.body">
      <p class="notice notice-warn" role="alert" data-testid="share-card.warning">${t("access.share.warning")}</p>
      <dl class="kv">
        <dt>${t("access.share.name")}</dt><dd data-user-content>${key.name || ""}</dd>
        ${key.class ? html`<dt>${t("access.field.class.label")}</dt><dd>${t(tk("access.class.", key.class))}</dd>` : null}
        <dt>${t("access.share.expires")}</dt><dd>${key.expiresAt ? fmt.dateTime(key.expiresAt, { style: "date" }) : t("access.expiry.never")}</dd>
        ${share?.recommendedModel ? html`<dt>${t("access.share.model")}</dt><dd class="mono" data-user-content>${share.recommendedModel}</dd>` : null}
        ${summary ? html`<dt>${t("access.share.limits")}</dt><dd>${summary}</dd>` : null}
        ${data?.kind === "rotate" && data.overlapSeconds ? html`<dt>${t("access.share.overlap")}</dt><dd>${t(tk("access.rotate.overlap.", data.overlapSeconds))}</dd>` : null}
      </dl>
      <${CopyRow} label=${t("access.share.key")} value=${data.secret} testid="share-card.key" autofocus />
      ${share?.openaiBase ? html`<${CopyRow} label=${t("access.share.openaiBase")} value=${share.openaiBase} testid="share-card.openai" />` : null}
      ${share?.anthropicBase ? html`<${CopyRow} label=${t("access.share.anthropicBase")} value=${share.anthropicBase} testid="share-card.anthropic" />` : null}
      ${share?.snippetCurl ? html`<section class="stack-sm"><h3 class="card-title">${t("access.share.curl")}</h3><${CodeBlock} code=${share.snippetCurl} language="bash" testid="share-card.curl" /></section>` : null}
      ${link ? html`<section class="stack-sm" data-testid="share-card.portal">
        <h3 class="card-title">${t("access.share.portal")}</h3>
        <p class="muted small">${t("access.share.portalHint")}</p>
        <${CopyRow} label=${t("access.share.portalLink")} value=${link} testid="share-card.portal-link" />
        <div class="share-qr"><${QrCode} text=${link} label=${t("access.share.qr")} testid="share-card.qr" /></div>
      </section>` : null}
      ${share?.openaiBase ? html`<${InviteBlock} data=${data} />` : null}
    </div>
  <//>`;
}
