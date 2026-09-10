import { initPlacement } from './placement-client';
import { copy, locale } from './i18n';
import { fontSupports } from './greeting-fonts';

document.addEventListener('input', event => {
  if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'closing-greeting') return;
  const fonts = document.querySelector<HTMLSelectElement>('#greeting-font');
  if (fonts) for (const option of fonts.options) option.disabled = !fontSupports(option.value, event.target.value);
});

const main = document.querySelector<HTMLElement>('main')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
let pending = false;
let wantsPayPal = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let previews: string[] = [];
let savedForm = '';
let outcomeUnknown = false;
const text = copy(locale(document.documentElement.lang));
function formFingerprint(): string {
  const form = panel.querySelector<HTMLFormElement>('#creation-form, #script-form, #placement-form');
  if (!form) return '';
  return JSON.stringify(Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type="hidden"]), textarea, select'), field =>
    field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')
      ? [field.name, field.value, field.checked]
      : field instanceof HTMLInputElement && field.type === 'file'
        ? [field.name, Array.from(field.files ?? [], file => [file.name, file.size, file.lastModified])]
        : [field.name, field.value]));
}
savedForm = formFingerprint();
function dirty(): boolean { return savedForm !== formFingerprint(); }
window.addEventListener('beforeunload', event => {
  if (!dirty()) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (!link || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#') || !dirty()) return;
  if (!window.confirm(text.unsavedLeave)) event.preventDefault();
  else savedForm = formFingerprint();
});
const MAX_CAMERA_PHOTO = 50 * 1024 * 1024;
const MAX_PREPARED_PHOTO = 2 * 1024 * 1024;
const photoHint = document.querySelector('#photo-hint');
if (photoHint) photoHint.textContent = text.photoHint;
const demo = document.querySelector<HTMLVideoElement>('#home-demo');
if (demo) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  demo.muted = true;
  const playback = (): void => {
    demo.autoplay = !motion.matches;
    if (motion.matches) demo.pause();
    else void demo.play().catch(() => undefined); // Native controls remain available if autoplay is blocked.
  };
  playback();
  motion.addEventListener('change', playback);
}
const busy = new Set([
  'uploading',
  'ordering',
  'awaiting_paypal',
  'capturing',
  'paid',
  'directing',
  'directed',
  'submitting',
  'generating',
  'ready',
  'choice',
  'correcting',
  'correction_directing',
  'correction_directed',
  'correction_submitting',
  'correction_generating',
  'selected',
  'video_directing',
  'video_directed',
  'provider_wait',
  'video_submitting',
  'video_generating',
]);
function submitStatus(form: HTMLFormElement, message: string, error = false): void {
  let status = form.querySelector<HTMLElement>('.submit-status');
  if (!status) {
    status = document.createElement('p');
    status.className = 'submit-status';
    status.tabIndex = -1;
    form.querySelector('button[type="submit"]')?.insertAdjacentElement('afterend', status);
  }
  status.setAttribute('role', error ? 'alert' : 'status');
  status.classList.toggle('submit-error', error);
  status.textContent = message;
  status.hidden = false;
  notice.hidden = true;
  if (error) {
    status.focus({ preventScroll: true });
    status.scrollIntoView({ block: 'nearest' });
  }
}
class PhotoError extends Error {}
function numbered(message: string, index: number): string {
  return message.replace('{number}', String(index + 1));
}
async function preparePhoto(file: File, index: number): Promise<File> {
  if (!file.size || file.size > MAX_CAMERA_PHOTO)
    throw new PhotoError(numbered(text.photoTooLarge, index));
  if (
    !['image/jpeg', 'image/png'].includes(file.type) &&
    !(file.type === '' && /\.(jpe?g|png)$/i.test(file.name))
  )
    throw new PhotoError(numbered(text.photoUnsupported, index));

  let bitmap: ImageBitmap | undefined;
  const canvas = document.createElement('canvas');
  try {
    // Browser decoding applies camera EXIF orientation before we draw. Each photo
    // is processed alone, then its decoded bitmap and canvas are released.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (!bitmap.width || !bitmap.height) throw new Error('Empty image');
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    bitmap = undefined;
    for (const quality of [0.9, 0.82, 0.72, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      );
      if (blob?.type === 'image/jpeg' && blob.size > 0 && blob.size <= MAX_PREPARED_PHOTO)
        return new File([blob], `photo-${index + 1}.jpg`, { type: 'image/jpeg' });
    }
    throw new Error('Image could not be prepared within the upload budget');
  } catch {
    throw new PhotoError(numbered(text.photoUnreadable, index));
  } finally {
    bitmap?.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
function update(data: { phase: string; html: string; approval: string | null; scriptRevision?: number }): void {
  if (wantsPayPal && data.approval && data.phase === 'awaiting_paypal') {
    savedForm = formFingerprint();
    location.assign(data.approval);
    return;
  }
  if (main.dataset.phase !== data.phase) {
    for (const url of previews) URL.revokeObjectURL(url);
    previews = [];
    panel.innerHTML = data.html;
    initPlacement();
    main.dataset.phase = data.phase;
    savedForm = formFingerprint();
    const heading = panel.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    notice.hidden = true;
  }
  const revision = panel.querySelector<HTMLInputElement>('#script-form input[name="revision"]');
  if (revision && data.scriptRevision !== undefined) revision.value = String(data.scriptRevision);
}
function schedule(): void {
  clearTimeout(timer);
  if (busy.has(main.dataset.phase ?? '')) timer = setTimeout(() => void poll(), 3000);
}
async function poll(): Promise<void> {
  if (pending) {
    schedule();
    return;
  }
  pending = true;
  try {
    const response = await fetch('/api/job', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (response.ok) update(await response.json());
    else if (response.status === 401 || response.status === 404) {
      location.assign('/create');
      return;
    } else {
      notice.hidden = false;
      notice.textContent = main.dataset.offline!;
    }
  } catch {
    notice.hidden = false;
    notice.textContent = main.dataset.offline!;
  } finally {
    pending = false;
    schedule();
  }
}
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.action.startsWith(location.origin + '/create/'))
    return;
  // Replacing the current story is an explicit native navigation, including
  // when JavaScript is unavailable. The server makes repeated POSTs idempotent.
  if (form.id === 'new-story-form' || form.id === 'edit-unpaid-form') return;
  event.preventDefault();
  if (pending || !form.reportValidity()) return;
  if (outcomeUnknown) {
    submitStatus(form, text.submissionUnknown, true);
    return;
  }
  const button = event.submitter as HTMLButtonElement | null;
  const data = new FormData(form);
  if (button?.name) data.set(button.name, button.value);
  const buttonLabel = button?.textContent;
  const controls = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      'input, textarea, select, button',
    ),
    (element) => ({ element, disabled: element.disabled }),
  );
  pending = true;
  form.setAttribute('aria-busy', 'true');
  for (const { element } of controls) element.disabled = true;
  if (button) {
    button.disabled = true;
    button.textContent = `${buttonLabel}…`;
  }
  void (async () => {
    try {
      if (form.id === 'creation-form') {
        const files = data.getAll('photos').filter((value): value is File => value instanceof File);
        if (files.length < 1 || files.length > 4 || files.some((file) => !file.size))
          throw new PhotoError(text.photoCount);
        data.delete('photos');
        for (const [index, file] of files.entries()) {
          submitStatus(
            form,
            numbered(text.photoPreparing, index).replace('{total}', String(files.length)),
          );
          // Let the browser paint the message beside the clicked button first.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          data.append('photos', await preparePhoto(file, index));
        }
        // Only this request receives prepared copies. The input's FileList and
        // every customer-entered field remain intact if preparation or upload fails.
        wantsPayPal = true;
        submitStatus(form, text.photoSending);
      }
      const response = await fetch(form.action, {
        method: 'POST',
        body: data,
        headers: { Accept: 'application/json' },
      });
      const result = await response.json();
      if (response.status >= 500) throw new Error('Submission outcome requires a saved-state check');
      if (!response.ok) {
        submitStatus(form, result.error ?? main.dataset.error!, true);
        wantsPayPal = false;
        return;
      }
      update(result);
      savedForm = formFingerprint();
      if (form.id === 'script-form' && form.isConnected) submitStatus(form, text.scriptSaved);
    } catch (error) {
      wantsPayPal = false;
      submitStatus(form, error instanceof PhotoError ? error.message : text.submissionUnknown, true);
      if (!(error instanceof PhotoError)) {
        outcomeUnknown = true;
        const check = document.createElement('button');
        check.type = 'button';
        check.className = 'secondary';
        check.textContent = text.checkSaved;
        check.addEventListener('click', () => {
          check.disabled = true;
          void (async () => {
            try {
              const response = await fetch('/api/job?inspect=1', { headers: { Accept: 'application/json' }, cache: 'no-store' });
              if (!response.ok) throw new Error();
              const result = await response.json();
              if (form.id === 'script-form' && result.phase === 'script_review') {
                const revision = form.querySelector<HTMLInputElement>('input[name="revision"]')!;
                const entered = form.querySelector<HTMLTextAreaElement>('textarea')!.value;
                const stored = new DOMParser().parseFromString(result.html, 'text/html').querySelector<HTMLTextAreaElement>('#video-script')?.value;
                if (Number(revision.value) !== result.scriptRevision && stored !== entered) {
                  outcomeUnknown = false;
                  submitStatus(form, text.scriptConflict, true);
                  check.remove();
                  return;
                }
                if (stored === entered) savedForm = formFingerprint();
              }
              update(result);
              outcomeUnknown = false;
              if (form.isConnected) submitStatus(form, text.safeRetry);
              check.remove();
            } catch { submitStatus(form, text.submissionUnknown, true); }
            finally { check.disabled = false; schedule(); }
          })();
        });
        form.append(check);
      }
    } finally {
      pending = false;
      form.removeAttribute('aria-busy');
      for (const { element, disabled } of controls) element.disabled = disabled;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = buttonLabel ?? '';
      }
      schedule();
    }
  })();
});
document.addEventListener('input', (event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.id === 'video-script' && event.target.form)
    submitStatus(event.target.form, text.scriptUnsaved);
});
document.addEventListener('change', (event) => {
  if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'photos') return;
  const target = document.querySelector('#photo-previews')!;
  for (const url of previews) URL.revokeObjectURL(url);
  previews = [];
  target.replaceChildren();
  for (const [i, file] of Array.from(event.target.files ?? [])
    .slice(0, 4)
    .entries()) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) continue;
    const url = URL.createObjectURL(file);
    previews.push(url);
    const figure = document.createElement('figure');
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    const caption = document.createElement('figcaption');
    caption.textContent = `${i + 1}`;
    figure.append(image, caption);
    target.append(figure);
  }
});
document.addEventListener('click', (event) => {
  if (!(event.target instanceof HTMLElement) || event.target.id !== 'share-video') return;
  const button = event.target as HTMLButtonElement;
  const fallback = (): void => {
    const note = document.querySelector<HTMLElement>('#share-note');
    if (note) {
      note.textContent = button.dataset.fallback ?? note.textContent;
      note.tabIndex = -1;
      note.focus();
    }
  };
  if (!navigator.share) {
    fallback();
    return;
  }
  button.disabled = true;
  void (async () => {
    try {
      const response = await fetch('/media/video');
      if (!response.ok) throw new Error();
      const file = new File([await response.blob()], 'talember-story.mp4', { type: 'video/mp4' });
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: 'My Talember story' });
      else fallback();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) fallback();
    } finally {
      button.disabled = false;
    }
  })();
});
schedule();

initPlacement();
