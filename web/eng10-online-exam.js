(function initEng10OnlineExam(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Eng10OnlineExam = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
  const ALLOWED_TYPES = new Set(['multiple_choice', 'fill_blank', 'sentence_rewrite']);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function cssString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function safeRichText(value) {
    return escapeHtml(value)
      .replace(/&lt;(\/?)(strong|u)&gt;/gi, '<$1$2>')
      .replace(/\n/g, '<br>');
  }

  function safeHttpUrl(value) {
    const s = String(value || '').trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(s) || /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(s)
      ? s.replace(/^data:image/i, m => m).replace(/\s+/g, '')
      : '';
  }

  function normalizeText(value) {
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[“”"'.!?;:()[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function questionKey(value) {
    return String(value ?? '').trim();
  }

  function normalizeImageKey(value) {
    return String(value ?? '')
      .trim()
      .replace(/^.*[\\/]/, '')
      .toLowerCase();
  }

  function stripImageExtension(value) {
    return normalizeImageKey(value).replace(/\.(png|jpe?g|webp|gif)$/i, '');
  }

  function cleanImageSlotKey(value) {
    return String(value ?? '')
      .trim()
      .replace(/^.*[\\/]/, '')
      .replace(/\.(png|jpe?g|webp|gif)$/i, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function imageKeyVariants(value) {
    const full = normalizeImageKey(value);
    const bare = stripImageExtension(full);
    const clean = cleanImageSlotKey(value);
    return Array.from(new Set([full, bare, clean].filter(Boolean)));
  }

  function imageSlotId(image, fallback) {
    return String(image?.id || image?.image_id || image?.file_name || image?.filename || image?.name || fallback || '').trim();
  }

  function imageSlotFileName(image, fallback) {
    return String(image?.file_name || image?.filename || image?.name || image?.id || image?.image_id || fallback || '').trim();
  }

  function normalizeImages(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw.map((item, index) => {
      if (typeof item === 'string') {
        return {
          id: item,
          file_name: item,
          alt: 'Hình ảnh trong đề',
          src: safeHttpUrl(item)
        };
      }
      const img = item && typeof item === 'object' ? { ...item } : {};
      const id = imageSlotId(img, `image_${index + 1}`);
      return {
        ...img,
        id,
        file_name: imageSlotFileName(img, id),
        alt: String(img.alt || img.caption || 'Hình ảnh trong đề'),
        caption: img.caption ? String(img.caption) : '',
        src: safeHttpUrl(img.src || img.url || img.data)
      };
    }).filter(img => img.id || img.file_name || img.src);
  }

  function normalizeQuestion(raw, index) {
    if (!raw || typeof raw !== 'object') throw new Error(`Question ${index + 1} is not an object`);
    const type = String(raw.type || '').trim();
    if (!ALLOWED_TYPES.has(type)) throw new Error(`Unsupported question type: ${type || '(empty)'}`);
    const id = raw.id;
    if (id === undefined || id === null || String(id).trim() === '') throw new Error(`Question ${index + 1} is missing id`);
    if (!String(raw.question || '').trim()) throw new Error(`Question ${id} is missing question`);
    if (raw.answer === undefined || raw.answer === null || String(raw.answer).trim() === '') throw new Error(`Question ${id} is missing answer`);
    if (type === 'multiple_choice' && (!Array.isArray(raw.options) || raw.options.length < 2)) {
      throw new Error(`Question ${id} is missing options`);
    }
    if (type === 'fill_blank' && !String(raw.blank_id || '').trim()) {
      throw new Error(`Question ${id} is missing blank_id`);
    }
    if (type === 'sentence_rewrite' && !String(raw.prompt || '').trim()) {
      throw new Error(`Question ${id} is missing prompt`);
    }
    return {
      ...raw,
      id,
      display_id: raw.display_id || raw.original_id || raw.original_label || String(id),
      type,
      question: String(raw.question || ''),
      options: Array.isArray(raw.options) ? raw.options.map(x => String(x ?? '')) : [],
      blank_id: raw.blank_id ? String(raw.blank_id) : '',
      prompt: raw.prompt ? String(raw.prompt) : '',
      answer: String(raw.answer ?? ''),
      answer_display: raw.answer_display ? String(raw.answer_display) : '',
      explanation: raw.explanation ? String(raw.explanation) : '',
      word_bank: Array.isArray(raw.word_bank) ? raw.word_bank.map(x => String(x ?? '')) : [],
      images: normalizeImages(raw.images || raw.image)
    };
  }

  function validateExamJson(input) {
    const exam = typeof input === 'string' ? JSON.parse(input) : input;
    if (!exam || typeof exam !== 'object' || Array.isArray(exam)) throw new Error('Exam JSON must be an object');
    if (!Array.isArray(exam.questions) || !exam.questions.length) throw new Error('Exam JSON must include questions');
    const questions = exam.questions.map(normalizeQuestion);
    const seenIds = new Set();
    const seenBlankIds = new Set();
    questions.forEach(q => {
      const id = questionKey(q.id);
      if (seenIds.has(id)) throw new Error(`Duplicate question id: ${id}`);
      seenIds.add(id);
      if (q.type === 'fill_blank') {
        if (seenBlankIds.has(q.blank_id)) throw new Error(`Duplicate blank_id: ${q.blank_id}`);
        seenBlankIds.add(q.blank_id);
      }
    });
    const pages = Array.isArray(exam.pages) ? exam.pages.map((page, index) => ({
      id: String(page?.id || `page_${index + 1}`),
      title: String(page?.title || `Phần ${index + 1}`),
      source_key: page?.source_key ? String(page.source_key) : '',
      question_ids: Array.isArray(page?.question_ids) ? page.question_ids : []
    })) : [];
    return {
      ...exam,
      exam_id: String(exam.exam_id || exam.id || ''),
      title: String(exam.title || 'Đề luyện thi online'),
      passage: exam.passage ? String(exam.passage) : '',
      fill_passage: exam.fill_passage ? String(exam.fill_passage) : '',
      images: normalizeImages(exam.images || exam.image),
      pages,
      questions
    };
  }

  function collectImageSlots(examInput) {
    const exam = validateExamJson(examInput);
    const slots = [];
    const seen = new Set();
    const pushSlot = (image, context, questionId) => {
      const slotId = imageSlotId(image, `${context}_${slots.length + 1}`);
      const fileName = imageSlotFileName(image, slotId);
      if (!slotId && !fileName) return;
      const key = normalizeText(slotId || fileName);
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      slots.push({
        slot_id: slotId,
        id: slotId,
        file_name: fileName,
        context,
        question_id: questionId || null,
        alt: String(image.alt || ''),
        caption: String(image.caption || '')
      });
    };
    exam.images.forEach(img => pushSlot(img, 'exam', null));
    exam.questions.forEach(q => q.images.forEach(img => pushSlot(img, 'question', q.id)));
    return slots;
  }

  function assetLookupKeys(asset) {
    return [
      asset?.slot_id,
      asset?.image_id,
      asset?.id,
      asset?.file_name,
      asset?.filename,
      asset?.name
    ].flatMap(imageKeyVariants);
  }

  function imageLookupKeys(image) {
    return [
      image?.id,
      image?.image_id,
      image?.file_name,
      image?.filename,
      image?.name
    ].flatMap(imageKeyVariants);
  }

  function hydrateExamAssetUrls(examInput, assetsInput) {
    const exam = validateExamJson(examInput);
    const assets = Array.isArray(assetsInput) ? assetsInput : [];
    const byKey = new Map();
    assets.forEach(asset => {
      const url = safeHttpUrl(asset?.url || asset?.signed_url || asset?.src);
      if (!url) return;
      assetLookupKeys(asset).forEach(key => byKey.set(key, url));
    });
    const hydrateImage = image => {
      for (const key of imageLookupKeys(image)) {
        if (byKey.has(key)) return { ...image, src: byKey.get(key) };
      }
      return { ...image, src: '' };
    };
    return {
      ...exam,
      images: exam.images.map(hydrateImage),
      questions: exam.questions.map(q => ({ ...q, images: q.images.map(hydrateImage) }))
    };
  }

  function answerForQuestion(q, answers) {
    if (q.type === 'multiple_choice') return answers[`mcq_${q.id}`] ?? answers[questionKey(q.id)] ?? '';
    if (q.type === 'fill_blank') return answers[`fill_${q.blank_id}`] ?? answers[`fill_${q.id}`] ?? '';
    if (q.type === 'sentence_rewrite') return answers[`rw_${q.id}`] ?? answers[`rewrite_${q.id}`] ?? '';
    return '';
  }

  function isQuestionCorrect(q, answers) {
    const user = answerForQuestion(q, answers);
    if (q.type === 'multiple_choice') {
      return normalizeText(user) === normalizeText(q.answer);
    }
    if (q.type === 'fill_blank') {
      return normalizeText(user) === normalizeText(q.answer);
    }
    if (q.type === 'sentence_rewrite') {
      const raw = normalizeText(user);
      const expected = normalizeText(q.answer);
      if (!raw || !expected) return false;
      if (raw === expected) return true;
      const words = expected.split(' ').filter(Boolean);
      if (!words.length) return false;
      const matched = words.filter(word => raw.includes(word)).length;
      return matched / words.length > 0.85;
    }
    return false;
  }

  function scoreExam(examInput, answersInput, durationSeconds) {
    const exam = validateExamJson(examInput);
    const answers = answersInput && typeof answersInput === 'object' ? answersInput : {};
    const total = exam.questions.length;
    const score = exam.questions.reduce((sum, q) => sum + (isQuestionCorrect(q, answers) ? 1 : 0), 0);
    return {
      score,
      total,
      percent: total ? Math.round((score / total) * 100) : 0,
      duration_seconds: Math.max(0, Math.round(Number(durationSeconds || 0) || 0))
    };
  }

  function questionTitle(q) {
    const label = String(q.display_id || q.id || '').trim();
    return /^câu\b/i.test(label) ? label : `Câu ${label}`;
  }

  function renderImages(source) {
    const images = normalizeImages(source?.images || source?.image);
    if (!images.length) return '';
    return `<div class="eng10-online-images">${images.map(img => `
      <figure class="eng10-online-image-frame">
        ${img.src
          ? `<img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.alt || 'Hình ảnh trong đề')}" loading="lazy">`
          : `<div class="eng10-online-missing-image"><strong>Thiếu ảnh</strong><span>${safeRichText(img.file_name || img.id || 'ảnh cần đính kèm')}</span></div>`}
        ${img.caption ? `<figcaption>${safeRichText(img.caption)}</figcaption>` : ''}
      </figure>`).join('')}</div>`;
  }

  function renderSource(exam, page) {
    const sourceKey = String(page?.source_key || '').toLowerCase();
    let html = '';
    if (sourceKey === 'passage' && exam.passage) {
      html += `<section class="eng10-online-source-block"><h3>Bài đọc</h3>${renderImages(exam)}${String(exam.passage).split('\n').map(p => `<p>${safeRichText(p)}</p>`).join('')}</section>`;
    } else if ((sourceKey === 'fill_passage' || sourceKey === 'fill') && exam.fill_passage) {
      html += `<section class="eng10-online-source-block"><h3>Đoạn điền từ</h3>${String(exam.fill_passage).split('\n').map(p => `<p>${safeRichText(p)}</p>`).join('')}</section>`;
    } else if (exam.images.length) {
      html += `<section class="eng10-online-source-block"><h3>Tư liệu đề</h3>${renderImages(exam)}</section>`;
    }
    return html || '<section class="eng10-online-source-block muted">Không có đoạn đọc riêng cho trang này.</section>';
  }

  function pageQuestions(exam, pageIndex) {
    if (!exam.pages.length) return exam.questions;
    const page = exam.pages[Math.max(0, Math.min(pageIndex, exam.pages.length - 1))] || exam.pages[0];
    const ids = new Set((page.question_ids || []).map(questionKey));
    return exam.questions.filter(q => ids.has(questionKey(q.id)));
  }

  function renderQuestion(q, answers, disabled) {
    const title = safeRichText(questionTitle(q));
    const body = safeRichText(q.question);
    if (q.type === 'multiple_choice') {
      return `<article class="eng10-online-q-card" data-qid="${escapeAttr(q.id)}">
        <div class="eng10-online-q-num">${title}</div>
        <div class="eng10-online-q-text">${body}</div>
        ${renderImages(q)}
        <div class="eng10-online-options">${q.options.map(opt => {
          const letter = String(opt).trim().match(/^([A-D])/i)?.[1]?.toUpperCase() || String(opt).trim().charAt(0).toUpperCase();
          const checked = String(answers[`mcq_${q.id}`] || '') === letter;
          return `<label class="eng10-online-option ${checked ? 'selected' : ''}">
            <input type="radio" name="mcq_${escapeAttr(q.id)}" value="${escapeAttr(letter)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span>${safeRichText(opt)}</span>
          </label>`;
        }).join('')}</div>
      </article>`;
    }
    if (q.type === 'fill_blank') {
      const key = `fill_${q.blank_id}`;
      return `<article class="eng10-online-q-card" data-qid="${escapeAttr(q.id)}">
        <div class="eng10-online-q-num">${title}</div>
        <div class="eng10-online-q-text">${body}</div>
        ${renderImages(q)}
        ${q.word_bank.length ? `<div class="eng10-online-word-bank">${q.word_bank.map(w => `<button type="button" data-fill-word="${escapeAttr(w)}" data-fill-target="${escapeAttr(key)}" ${disabled ? 'disabled' : ''}>${safeRichText(w)}</button>`).join('')}</div>` : ''}
        <input class="eng10-online-input" name="${escapeAttr(key)}" value="${escapeAttr(answers[key] || '')}" placeholder="Gõ đáp án..." ${disabled ? 'disabled' : ''}>
      </article>`;
    }
    const key = `rw_${q.id}`;
    return `<article class="eng10-online-q-card" data-qid="${escapeAttr(q.id)}">
      <div class="eng10-online-q-num">${title}</div>
      <div class="eng10-online-q-text">${body}</div>
      ${renderImages(q)}
      <div class="eng10-online-rewrite-prompt">${safeRichText(q.prompt)}</div>
      <textarea class="eng10-online-input" name="${escapeAttr(key)}" rows="2" placeholder="Gõ câu hoàn chỉnh..." ${disabled ? 'disabled' : ''}>${escapeHtml(answers[key] || '')}</textarea>
    </article>`;
  }

  function createRunner(options) {
    const opts = options || {};
    const state = {
      exam: validateExamJson(opts.exam || {}),
      assets: Array.isArray(opts.assets) ? opts.assets : [],
      answers: {},
      pageIndex: 0,
      startedAt: Date.now(),
      submitted: false,
      result: null
    };
    state.exam = hydrateExamAssetUrls(state.exam, state.assets);
    const container = opts.container;
    if (!container) throw new Error('Missing runner container');

    function syncAnswers() {
      container.querySelectorAll('input[type="radio"]:checked').forEach(input => {
        state.answers[input.name] = input.value;
      });
      container.querySelectorAll('input.eng10-online-input, textarea.eng10-online-input').forEach(input => {
        state.answers[input.name] = input.value;
      });
    }

    function progressText() {
      const answered = state.exam.questions.filter(q => String(answerForQuestion(q, state.answers) || '').trim()).length;
      return `${answered}/${state.exam.questions.length} câu`;
    }

    async function submit() {
      syncAnswers();
      const duration = Math.round((Date.now() - state.startedAt) / 1000);
      if (typeof opts.onSubmit === 'function') {
        state.result = await opts.onSubmit({ answers: state.answers, duration_seconds: duration });
      } else {
        state.result = scoreExam(state.exam, state.answers, duration);
      }
      state.submitted = true;
      render();
    }

    function render() {
      const page = state.exam.pages[state.pageIndex] || { id: 'all', title: 'Toàn bộ đề', question_ids: state.exam.questions.map(q => q.id) };
      const questions = pageQuestions(state.exam, state.pageIndex);
      const totalPages = Math.max(1, state.exam.pages.length || 1);
      container.innerHTML = `<div class="eng10-online-shell">
        <header class="eng10-online-head">
          <button type="button" class="eng10-online-icon-btn" data-action="close" aria-label="Đóng">×</button>
          <div>
            <div class="eng10-online-kicker">Làm bài online</div>
            <h2>${safeRichText(state.exam.title)}</h2>
          </div>
          <div class="eng10-online-progress">${safeRichText(progressText())}</div>
        </header>
        ${state.submitted ? `<section class="eng10-online-result">
          <div class="eng10-online-score">${safeRichText(state.result?.score ?? 0)}<span>/${safeRichText(state.result?.total ?? state.exam.questions.length)}</span></div>
          <div class="eng10-online-result-text">Điểm ${safeRichText(state.result?.percent ?? 0)}% · ${safeRichText(state.result?.duration_seconds ?? 0)} giây</div>
        </section>` : ''}
        <div class="eng10-online-main">
          <aside class="eng10-online-source">${renderSource(state.exam, page)}</aside>
          <section class="eng10-online-paper">
            <div class="eng10-online-page-title">
              <strong>${safeRichText(page.title || 'Phần bài làm')}</strong>
              <span>Trang ${state.pageIndex + 1}/${totalPages}</span>
            </div>
            ${questions.map(q => renderQuestion(q, state.answers, state.submitted)).join('')}
          </section>
        </div>
        <footer class="eng10-online-foot">
          <button type="button" data-action="prev" ${state.pageIndex <= 0 ? 'disabled' : ''}>Trang trước</button>
          <button type="button" data-action="next" ${state.pageIndex >= totalPages - 1 ? 'disabled' : ''}>Trang sau</button>
          <button type="button" class="primary" data-action="submit" ${state.submitted ? 'disabled' : ''}>Nộp bài</button>
        </footer>
      </div>`;
    }

    container.addEventListener('input', syncAnswers);
    container.addEventListener('change', syncAnswers);
    container.addEventListener('click', event => {
      const target = event.target.closest('[data-action],[data-fill-word]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      if (target.hasAttribute('data-fill-word')) {
        const input = container.querySelector(`[name="${cssString(target.getAttribute('data-fill-target') || '')}"]`);
        if (input && !input.disabled) {
          input.value = target.getAttribute('data-fill-word') || '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
      if (action === 'close' && typeof opts.onClose === 'function') opts.onClose();
      if (action === 'prev') {
        syncAnswers();
        state.pageIndex = Math.max(0, state.pageIndex - 1);
        render();
      }
      if (action === 'next') {
        syncAnswers();
        state.pageIndex = Math.min(Math.max(0, state.exam.pages.length - 1), state.pageIndex + 1);
        render();
      }
      if (action === 'submit') {
        submit().catch(err => {
          if (typeof opts.onError === 'function') opts.onError(err);
        });
      }
    });
    render();
    return {
      state,
      render,
      syncAnswers,
      score: () => scoreExam(state.exam, state.answers, Math.round((Date.now() - state.startedAt) / 1000))
    };
  }

  return {
    collectImageSlots,
    createRunner,
    escapeHtml,
    hydrateExamAssetUrls,
    isQuestionCorrect,
    normalizeText,
    safeRichText,
    scoreExam,
    validateExamJson
  };
});
