import { busy, displayPhase, reviewing, MAX_SCRIPT, MAX_CLOSING_WISH, PRICE, enabled, paymentEnvironment, type Job, type ServiceEnv } from './types';
import { copy, price, type Locale } from './i18n';
import { overlayCopy, effectCopy, colorCopy } from './overlay';
import { placementPanel, adjustButton } from './placement';
import { fontNames, fontSupports, fontLabel } from './greeting-fonts';

export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function hidden(job: Job): string {
  return `<input type="hidden" name="csrf" value="${job.csrf}">`;
}
function startAnother(job: Job, language = job.locale): string {
  const t = copy(language);
  return `<details class="start-another"><summary>${t.back}</summary>
    <form id="new-story-form" action="/create/new?lang=${language}" method="post">${hidden(job)}
    <p id="new-story-hint">${t.newConfirmHint}</p>
    <a class="secondary" href="/media/video?download=1" download="talember-story.mp4">${t.download}</a>
    <button class="primary" type="submit" name="confirmation" value="saved" aria-describedby="new-story-hint">${t.newConfirm}</button></form></details>`;
}
export function home(job: Job | null, language: Locale, verifiedDemo = false, env?: ServiceEnv): string {
  const t = copy(language);
  const completed = job?.phase === 'complete' && job.video_key;
  const emptyDraft = job?.phase === 'draft' && job.story === null && job.cast === null &&
    job.photos_json === null && job.snapshot_at === null && job.order_id === null && job.paid_at === null;
  const action = `<a class="primary" href="/create?lang=${language}">${completed ? t.viewVideo : job && !emptyDraft ? t.resume : t.start}</a>`;
  // This owner-approved presentation example is not a claim about provider output.
  const movie = verifiedDemo ? `<figure class="landing-film"><video id="home-demo" controls muted loop playsinline preload="metadata" width="1280" height="720" poster="/assets/preview/placeholder.svg" src="/assets/preview/demo.mp4" aria-label="${escape(t.homeVideo)}"></video><figcaption>${t.homeVideo}</figcaption></figure>` : '';
  const content = `<section class="landing-hero" aria-labelledby="home-title"><div class="landing-copy">
    <p class="landing-eyebrow">${t.homeTagline}</p><p class="landing-name" aria-hidden="true">talember</p>
    <h1 id="home-title">${t.homeTitle}</h1><p class="landing-intro">${t.homeIntro}</p>${action}
    <p class="landing-note">${t.homeNote}</p>
    ${completed ? `<p class="hint availability">${t.videoAvailable}</p>${startAnother(job, language)}` : ''}</div>
    <div class="landing-example"><div class="landing-sample-card"><p>${t.homeSampleText}</p>
    <div class="landing-samples">${movie}</div>
    </div></div></section>
    <section id="how" class="landing-how" aria-labelledby="how-title"><h2 class="landing-eyebrow" id="how-title">${t.homeHow}</h2>
    <ol>${[[t.homeUpload, t.homeUploadText], [t.homeStory, t.homeStoryText], [t.homeReview, t.homeReviewText], [t.homeReceive, t.homeReceiveText]].map(([title, description], index) => `<li><span class="landing-eyebrow" aria-hidden="true">0${index + 1}</span><h3>${title}</h3><p>${description}</p></li>`).join('')}</ol></section>
    <section id="for-you" class="landing-for" aria-labelledby="for-title"><h2 id="for-title">${t.homeFor}</h2><p>${t.homeForIntro}</p><div class="landing-for-cards">${[[t.homeLoved, t.homeLovedText], [t.homePets, t.homePetsText], [t.homeMemory, t.homeMemoryText], [t.homeOccasion, t.homeOccasionText]].map(([title, description]) => `<article><h3>${title}</h3><p>${description}</p></article>`).join('')}</div></section>
    <section id="pricing" class="landing-pricing" aria-labelledby="price-title"><div><p class="landing-eyebrow">${t.homePricing}</p><h2 id="price-title">${t.homePriceTitle}</h2><p>${t.offer}</p><p>${t.included}</p></div><div class="landing-price-action"><span class="price">${price(language, PRICE)}</span>${action}</div></section>
    <section id="faq" class="landing-faq" aria-labelledby="faq-title"><h2 id="faq-title">${t.homeFaq}</h2><div>
    ${[[t.homeEditQuestion, t.homeEditAnswer], [t.homeSoundQuestion, t.homeSoundAnswer], [t.homeAccessQuestion, t.privacy]].map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('')}</div></section>`;
  return documentPage(language, content, 'home', '', false, env);
}
export interface ScriptDraft { text: string; revision: string; greeting?: string; effect?: string; color?: string; font?: string }
export function panel(job: Job, env: ServiceEnv, draft?: ScriptDraft, saved = false): string {
  const t = copy(job.locale);
  if (job.issue === 'provider_balance')
    return `<div class="center" role="status"><h1>${t.serviceDelay}</h1><p>${t.serviceDelayHint}</p><a class="secondary" href="/support?lang=${job.locale}">${t.support}</a></div>`;
  if (job.phase === 'draft')
    return `<div class="intro"><h1>${t.title}</h1><p>${t.intro}</p></div>
    <form id="creation-form" action="/create/checkout" method="post" enctype="multipart/form-data" class="creation-form">
      ${hidden(job)}<div class="fields"><div class="field"><label for="photos">${t.photos}</label><p id="photo-hint" class="hint">${t.photoHint}</p>
      <input id="photos" name="photos" type="file" accept="image/jpeg,image/png" multiple required aria-describedby="photo-hint"><div id="photo-previews" class="photo-previews"></div></div>
      <div class="field"><label for="cast">${t.cast}</label><input id="cast" name="cast" type="text" maxlength="400" value="${escape(job.cast ?? '')}" required aria-describedby="cast-hint"><p id="cast-hint" class="hint">${t.castHint}</p></div>
      <div class="field count-field"><label for="participants">${t.count}</label><select id="participants" name="participants">${[1, 2, 3, 4].map((n) => `<option ${job.participants === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <fieldset class="style-previews"><legend>${t.scriptStyle}</legend><div class="style-cards">${(['cartoon', 'realistic'] as const).map((style) => `<label class="style-card"><img src="/assets/styles/${style === 'cartoon' ? 'cartoon' : 'realism'}-v1.svg" alt="" width="480" height="480" loading="lazy" decoding="async"><span class="style-card-title"><input type="radio" name="style" value="${style}" ${job.style === style ? 'checked' : ''}><strong>${t[style]}</strong></span><span class="style-card-description">${style === 'cartoon' ? t.cartoonDescription : t.realismDescription}</span></label>`).join('')}</div><p class="hint">${t.styleExamples}</p></fieldset>
      <fieldset class="style-choice"><legend>${t.format}</legend>${(['match', 'vertical', 'horizontal'] as const).map((format) => `<label><input type="radio" name="video_format" value="${format}" ${job.video_format === format ? 'checked' : ''}>${format === 'match' ? t.matchPhoto : t[format]}</label>`).join('')}</fieldset>
      <div class="field"><label for="story">${t.story}</label><textarea id="story" name="story" rows="4" minlength="10" maxlength="800" placeholder="${escape(t.storyPlaceholder)}" required aria-describedby="story-hint">${escape(job.story ?? '')}</textarea><p id="story-hint" class="hint">${t.storyHint}</p>${job.story ? `<p class="hint">${t.reselect}</p>` : ''}</div>
      <div class="field"><label for="closing-wish">${t.wishLabel}</label><input id="closing-wish" name="closing_wish" type="text" dir="auto" list="wish-suggestions" maxlength="${MAX_CLOSING_WISH}" value="${escape(job.closing_wish ?? '')}" placeholder="${escape(t.wishPlaceholder)}" aria-describedby="wish-hint"><datalist id="wish-suggestions">${[t.wishBirthday, t.wishLove, t.wishThanks].map(wish => `<option value="${escape(wish)}"></option>`).join('')}</datalist><p id="wish-hint" class="hint">${t.wishHint}</p></div>
      <label class="consent"><input type="checkbox" name="consent" value="yes" required><span>${t.consent}</span></label></div>
      <aside class="offer"><span class="price">${price(job.locale, job.amount)}</span><p class="offer-title">${t.offer}</p><p>${t.included}</p>
      <button class="primary" type="submit" ${enabled(env, job.id, job.payment_environment) ? '' : 'disabled'}>${t.pay} <span aria-hidden="true">↗</span></button>
      <p class="hint">${t.cardHint}</p>
      <p class="submit-status" role="status" tabindex="-1" hidden></p>
      ${enabled(env, job.id, job.payment_environment) ? '' : `<p class="hint">${t.paused}</p>`}<p class="privacy">${t.privacy}</p></aside>
    </form>`;
  if (job.phase === 'awaiting_paypal')
    return `<div class="center"><h1>${t.pending}</h1><p>${t.pendingHint}</p><a class="primary" href="${escape(job.approval_url!)}">${t.pay}</a><p class="hint">${t.cardHint}</p><form id="edit-unpaid-form" method="post" action="/create/edit">${hidden(job)}<p>${t.reselect}</p><button class="secondary" type="submit">${t.editUnpaid}</button></form></div>`;
  if (reviewing(job))
    return `<div class="result-heading"><h1>${t.scriptTitle}</h1></div>
    <div class="script-review">
    <form id="script-form" action="/create/script" method="post" enctype="multipart/form-data" class="fields">
    ${hidden(job)}<input type="hidden" name="revision" value="${escape(draft?.revision ?? String(job.video_script_revision))}">
    <div class="field"><label for="video-script">${t.scriptLabel}</label><textarea id="video-script" name="script" dir="auto" rows="18" minlength="10" maxlength="${MAX_SCRIPT}" required aria-describedby="script-hint">${escape(draft?.text ?? job.video_script!)}</textarea><p class="hint" id="script-hint">${t.scriptHint}</p></div>
    ${job.overlay_version === 1 ? `<div class="field"><label for="closing-greeting">${t.scriptWish}</label><input id="closing-greeting" name="greeting" dir="auto" maxlength="80" value="${escape(draft?.greeting ?? job.closing_wish ?? '')}" aria-describedby="greeting-hint"><p id="greeting-hint" class="hint">${overlayCopy[job.locale]}</p></div><div class="field"><label for="greeting-effect">${effectCopy[job.locale][0]}</label><select id="greeting-effect" name="effect">${['none','hearts','fireworks','celebration'].map((effect,i)=>`<option value="${effect}"${(draft?.effect ?? job.greeting_effect ?? 'none') === effect ? ' selected' : ''}>${effectCopy[job.locale][i+1]}</option>`).join('')}</select></div>` : ''}
    ${job.overlay_version === 1 ? `<div class="field"><label for="greeting-color">${colorCopy[job.locale][0]}</label><select id="greeting-color" name="color">${['white','gold','pink','multicolor'].map((color,i)=>`<option value="${color}"${(draft?.color ?? job.greeting_color ?? 'white') === color ? ' selected' : ''}>${colorCopy[job.locale][i+1]}</option>`).join('')}</select></div>` : ''}
    ${job.overlay_version === 1 ? `<div class="field"><label for="greeting-font">${fontLabel[job.locale]}</label><select id="greeting-font" name="font">${Object.entries(fontNames).map(([font,name])=>`<option value="${font}"${(draft?.font ?? job.greeting_font ?? 'classic') === font ? ' selected' : ''}${fontSupports(font,draft?.greeting ?? job.closing_wish ?? '') ? '' : ' disabled'}>${name}</option>`).join('')}</select></div>` : ''}
    <div class="script-actions"><button class="primary" type="submit" name="intent" value="approve" ${enabled(env, job.id, job.payment_environment) ? '' : 'disabled'}>${t.scriptApprove}</button><button class="secondary" type="submit" name="intent" value="save">${t.scriptSave}</button></div>
    <p class="submit-status" role="status" tabindex="-1" ${saved ? '' : 'hidden'}>${saved ? t.scriptSaved : ''}</p></form></div>`;
  if (job.overlay_review) return placementPanel(job);
  if (busy(job)) {
    const message = ['ordering', 'uploading'].includes(job.phase)
      ? t.preparing
      : job.phase === 'capturing'
        ? t.payment
        : job.phase.startsWith('correction') || job.phase === 'correcting'
          ? t.preparing
          : ['selected', 'ready', 'choice', 'video_directing'].includes(job.phase) || (job.phase === 'video_directed' && !job.video_script_approved_at)
            ? t.scriptPreparing
            : job.phase.startsWith('video') ? t.filming
            : job.style === 'cartoon' ? t.painting : t.rendering;
    return `<div class="center progress" role="status"><div class="spark" aria-hidden="true">✦</div><h1>${message}</h1><p>${t.wait}</p></div>`;
  }
  if (job.phase === 'complete' && job.video_key)
    return `<div class="result-heading"><h1>${t.done}</h1><p>${t.doneHint}</p></div>
    <div class="finished"><video controls playsinline preload="metadata" src="/media/video" aria-label="${t.done}"></video>
    <div class="video-actions"><a class="primary" href="/media/video?download=1" download="talember-story.mp4">${t.download}</a><button type="button" class="secondary" id="share-video" data-fallback="${escape(t.shareUnavailable)}">${t.share}</button><p id="share-note" class="hint" role="status">${t.shareHint}</p><p class="hint">${t.videoAvailable}</p>${adjustButton(job)}${startAnother(job)}</div></div>`;
  return `<div class="center"><h1>${t.attention}</h1><p>${job.issue === 'content_expired' ? t.expired : t.attentionHint}</p><p class="reference">${escape(job.id)}</p><a class="secondary" href="/support?lang=${job.locale}">${t.support}</a>${job.issue === 'unpaid_cancelled' ? `<form id="edit-unpaid-form" method="post" action="/create/edit">${hidden(job)}<button class="secondary" type="submit">${t.editUnpaid}</button></form>` : ''}</div>`;
}
export function page(job: Job, env: ServiceEnv, error = '', draft?: ScriptDraft, saved = false): string {
  const t = copy(job.locale);
  const preserveDraft = draft && !reviewing(job);
  const content = preserveDraft
    ? `<div class="fields"><div class="field"><label for="preserved-script">${t.scriptLabel}</label><textarea id="preserved-script" dir="auto" rows="18" readonly>${escape(draft.text)}</textarea></div><p>${t.scriptConflict}</p><a class="secondary" href="/create">${t.sceneReady}</a></div>`
    : panel(job, env, draft, saved);
  return documentPage(job.locale, content, draft ? 'script_error' : displayPhase(job), error, busy(job) && !draft, env, job.payment_environment);
}
export function information(kind: 'support' | 'privacy' | 'refunds', language: Locale, env: ServiceEnv): string {
  const t = copy(language);
  const title = kind === 'support' ? t.support : kind === 'privacy' ? t.privacyPolicy : t.refundPolicy;
  const body = kind === 'support' ? t.supportBody : kind === 'privacy' ? t.privacyBody : t.refundBody;
  let contact = '';
  try {
    const url = new URL(env.TALEMBER_SUPPORT_URL ?? '');
    if (['https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password)
      contact = `<a class="secondary" href="${escape(url.href)}">${t.support}</a>`;
  } catch { /* Missing owner input stays explicit. */ }
  return documentPage(language, `<div class="fields"><h1>${title}</h1><p>${body}</p>${contact || `<p>${t.supportMissing}</p>`}</div>`, kind, '', false, env);
}
function documentPage(language: Locale, content: string, phase: string, error = '', refresh = false, env?: ServiceEnv, mode = env ? paymentEnvironment(env) : 'sandbox'): string {
  const t = copy(language);
  const path = phase === 'home' ? '/' : ['support', 'privacy', 'refunds'].includes(phase) ? `/${phase}` : '/create';
  const langs: [Locale, string][] = [
    ['en', 'EN'],
    ['ru', 'RU'],
    ['es', 'ES'],
    ['he', 'HE'],
  ];
  return `<!doctype html><html lang="${language}" dir="${language === 'he' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Talember — ${phase === 'home' ? t.home : t.sceneReady}</title><meta name="robots" content="noindex, nofollow"><link rel="icon" href="/assets/brand/favicon.svg"><link rel="stylesheet" href="/styles/service.css"><script src="/scripts/service.js" defer></script>${refresh ? '<noscript><meta http-equiv="refresh" content="5;url=/create?advance=1"></noscript>' : ''}</head>
    <body${phase === 'home' ? ' class="landing"' : ''}><a class="skip" href="#story-main">${t.skip}</a><header><a href="/?lang=${language}" aria-label="Talember — ${t.home}">${phase === 'home' ? '<span class="landing-wordmark">talember</span>' : '<img class="logo" src="/assets/brand/logo.svg" alt="Talember" width="180" height="70">'}</a>${phase === 'home' ? `<nav class="landing-nav" aria-label="${t.home}"><a href="/create?lang=${language}">${t.start}</a><a href="#pricing">${t.homePricing}</a><a href="#faq">${t.homeFaq}</a></nav>` : ''}<div class="header-tools">${mode === 'sandbox' ? `<span class="sandbox">${t.sandbox}</span>` : ''}<nav aria-label="${t.language}">${langs.map(([code, label]) => `<a href="${path}?lang=${code}" lang="${code}" ${language === code ? 'aria-current="true"' : ''}>${label}</a>`).join('')}</nav></div></header>
    <main id="story-main" data-phase="${phase}" data-error="${t.error}" data-offline="${t.offline}">${phase === 'home' ? '' : `<a class="home-link" href="/?lang=${language}">${language === 'he' ? '→' : '←'} ${t.home}</a>`}<div id="notice" role="alert" tabindex="-1" ${error ? '' : 'hidden'}>${escape(error)}</div><section id="panel">${content}</section></main>${phase === 'home' ? `<footer><div><a class="landing-wordmark" href="/?lang=${language}">talember</a><p>${t.private}</p></div><nav aria-label="${t.home}"><a href="/create?lang=${language}">${t.start}</a><a href="#how">${t.homeHow}</a><a href="#for-you">${t.homeFor}</a><a href="#pricing">${t.homePricing}</a><a href="#faq">${t.homeFaq}</a></nav><nav aria-label="${t.language}">${langs.map(([code, label]) => `<a href="/?lang=${code}" lang="${code}">${label}</a>`).join('')}</nav></footer>` : `<footer><span>Talember</span><span>${t.private}</span></footer>`}<nav class="policy-links" aria-label="${t.support}"><a href="/support?lang=${language}">${t.support}</a> · <a href="/privacy?lang=${language}">${t.privacyPolicy}</a> · <a href="/refunds?lang=${language}">${t.refundPolicy}</a></nav></body></html>`;
}
