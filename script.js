const fileInput = document.getElementById('fileInput');
const previewWrap = document.getElementById('previewWrap');
const imagePreview = document.getElementById('imagePreview');
const pdfPreview = document.getElementById('pdfPreview');
const fileName = document.getElementById('fileName');
const readButton = document.getElementById('readButton');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const message = document.getElementById('message');
const detectedSection = document.getElementById('detectedSection');
const detectedText = document.getElementById('detectedText');
const subjectRows = document.getElementById('subjectRows');
const resultError = document.getElementById('resultError');
const resultsSection = document.getElementById('resultsSection');

let selectedFile = null;
let pdfDocument = null;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function showMessage(text, type = 'info') {
  message.textContent = text;
  message.className = `message ${type === 'error' ? 'error' : ''}`;
  message.classList.remove('hidden');
}
function clearMessage() { message.classList.add('hidden'); }
function setProgress(percent, text) {
  progressWrap.classList.remove('hidden');
  progressBar.style.width = `${percent}%`;
  progressText.textContent = text;
}
function hideProgress() { progressWrap.classList.add('hidden'); progressBar.style.width = '0%'; }

fileInput.addEventListener('change', async () => {
  selectedFile = fileInput.files?.[0] || null;
  pdfDocument = null;
  clearMessage();
  readButton.disabled = !selectedFile;
  imagePreview.classList.add('hidden');
  pdfPreview.classList.add('hidden');
  previewWrap.classList.toggle('hidden', !selectedFile);
  if (!selectedFile) return;
  fileName.textContent = `${selectedFile.name} · ${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`;

  const isPdf = selectedFile.type === 'application/pdf' || selectedFile.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    try {
      if (!window.pdfjsLib) throw new Error('PDF.js could not load. Check your internet connection and refresh.');
      const bytes = await selectedFile.arrayBuffer();
      pdfDocument = await pdfjsLib.getDocument({ data: bytes }).promise;
      await renderPdfPage(pdfDocument, 1, pdfPreview);
      pdfPreview.classList.remove('hidden');
    } catch (error) {
      showMessage(`Could not open this PDF: ${error.message}`, 'error');
      readButton.disabled = true;
    }
  } else if (selectedFile.type.startsWith('image/')) {
    imagePreview.src = URL.createObjectURL(selectedFile);
    imagePreview.onload = () => imagePreview.classList.remove('hidden');
  } else {
    showMessage('Please select a JPG, JPEG, PNG, WEBP, or PDF file.', 'error');
    readButton.disabled = true;
  }
});

async function renderPdfPage(pdf, pageNumber, canvas) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2.5 });
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function prepareOcrImage(source) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw new Error('The selected image has invalid dimensions.');

  const scale = Math.min(3, Math.max(1, 2800 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not prepare the image for text recognition.');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.25 + 128));
    pixels[index] = contrast;
    pixels[index + 1] = contrast;
    pixels[index + 2] = contrast;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

async function recognizeMarksheet(worker, image) {
  const text = [];
  for (const pageSegMode of ['6', '11']) {
    await worker.setParameters({ tessedit_pageseg_mode: pageSegMode });
    const result = await worker.recognize(image);
    text.push(...result.data.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  }
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  return text;
}

readButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  clearMessage();
  readButton.disabled = true;
  const allText = [];
  let ocrWorker = null;
  let currentPage = 0;
  try {
    if (!window.Tesseract) throw new Error('Tesseract.js could not load. Check your internet connection and refresh.');
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: info => {
        if (info.status === 'recognizing text') {
          if (pdfDocument) {
            const base = (currentPage - 1) / pdfDocument.numPages;
            setProgress(
              Math.round((base + info.progress / pdfDocument.numPages) * 100),
              `Reading PDF page ${currentPage} of ${pdfDocument.numPages}…`
            );
          } else {
            setProgress(Math.round(info.progress * 100), `Reading mark sheet… ${Math.round(info.progress * 100)}%`);
          }
        } else if (info.status) {
          progressText.textContent = info.status;
        }
      }
    }, {
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });

    if (pdfDocument) {
      for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
        currentPage = pageNum;
        setProgress(Math.round(((pageNum - 1) / pdfDocument.numPages) * 100), `Reading PDF page ${pageNum} of ${pdfDocument.numPages}…`);
        const canvas = document.createElement('canvas');
        await renderPdfPage(pdfDocument, pageNum, canvas);
        const ocrImage = await prepareOcrImage(canvas);
        allText.push(...await recognizeMarksheet(ocrWorker, ocrImage));
      }
    } else {
      setProgress(0, 'Loading OCR engine…');
      const image = await createImageBitmap(selectedFile);
      let ocrImage;
      try {
        ocrImage = await prepareOcrImage(image);
      } finally {
        image.close();
      }
      allText.push(...await recognizeMarksheet(ocrWorker, ocrImage));
    }
    detectedText.textContent = allText.join('\n') || 'No text was detected.';
    detectedSection.classList.remove('hidden');
    const rows = parseOcrText(allText);
    subjectRows.innerHTML = '';
    rows.forEach(addSubjectRow);
    if (rows.length) {
      const incompleteRows = rows.filter(row => row.credits === '' || row.gradePoint === '').length;
      const details = incompleteRows
        ? ` Credits or grade points could not be read for ${incompleteRows} row(s); fill those in manually.`
        : '';
      showMessage(`OCR finished. Found ${rows.length} possible subject row(s). Please review them carefully.${details}`);
    }
    else showMessage('Text was detected, but no subject rows could be identified. Add your subjects manually.', 'error');
  } catch (error) {
    showMessage(`Could not read the marksheet: ${error.message}`, 'error');
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    hideProgress();
    readButton.disabled = false;
  }
});

function parseLine(line, creditPointLayout = false) {
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const numbers = normalized.match(/\d+(?:[.,]\d+)?/g);
  if (!numbers || numbers.length < 2) return null;

  const values = numbers.map(value => Number(value.replace(',', '.')));
  if (/^\s*(?:\+\s*)?\d{1,2}(?=\s+[A-Za-z])/.test(normalized)) values.shift();
  else if (/^\s*\d+\s*[|.)-]/.test(normalized)) values.shift();
  if (values.length < 2) return null;

  const subject = normalized
    .replace(/\d+(?:[.,]\d+)?/g, ' ')
    .replace(/\b(?:pass|fail|th|pr|sr|jr|roll|code|id|no|reg|sem|sgpa|cgpa|gpa|credits?|grade|subject|marks?|result|exam|semester|total|session|student|name|date|college|university|year)\b/ig, ' ')
    .replace(/[|\\/\-_:;,.+™»?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:[a-f](?:[+-])?|ab|at)$/i, '')
    .trim();

  if (!subject || !/[a-z]/i.test(subject)) return null;
  if (/\b(total|semester|result|gpa|cgpa|percentage|credits?|grade|marks?|subject|name|session|student|college|university|roll|reg|date|print|view|details|note|exam|code)\b/i.test(subject)) return null;

  let credits = null;
  let gradePoint = null;

  const rangeNumbers = values.filter(value => value >= 0 && value <= 10);
  if (rangeNumbers.length >= 2) {
    [credits, gradePoint] = rangeNumbers.slice(0, 2);
  } else if (creditPointLayout && values.length >= 2 && values[0] > 0) {
    gradePoint = values[0];
    credits = values[1] / gradePoint;
  }

  if (credits === null || gradePoint === null) return null;
  if (credits < 0 || credits > 10 || gradePoint < 0 || gradePoint > 10) return null;

  return { subject, credits, gradePoint };
}

function cleanOcrSubject(text) {
  return String(text || '')
    .replace(/\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(?:th|pr|pass|fail|ab|at)\b\.?/ig, ' ')
    .replace(/[|\\/\-_:;,.=+™»]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:[a-f][+-]?|pass|fail|ab|at|[ivx]+)$/i, '')
    .trim();
}

function parseSubjectTableLines(lines) {
  const headerIndex = lines.findIndex(line =>
    /\bsubject\s*name\b/i.test(line) ||
    (/\bsubject\b/i.test(line) && /\bname\b/i.test(line))
  );
  if (headerIndex < 0) return [];

  const rows = [];
  const seen = new Set();

  for (const line of lines.slice(headerIndex + 1)) {
    if (/\b(?:college|total\s+credits|sgpa|cgpa|result\s+announced)\b/i.test(line)) break;

    const serialMatch = line.match(/^\s*(?:\+\s*\|\s*|\|\s*)?(\d{1,2})(?=\s*(?:[|.)-]|\s+[A-Za-z]|$))/);
    const plusRowMatch = line.match(/^\s*\+\s*\|?\s*/);
    if (!serialMatch && !plusRowMatch) continue;

    const afterSerial = serialMatch
      ? line.slice(serialMatch[0].length).replace(/^\s*[|.)-]?\s*/, '')
      : line.slice(plusRowMatch[0].length).replace(/^\s*\|\s*/, '');
    const cells = afterSerial.split('|').map(cell => cell.trim()).filter(Boolean);
    let subjectCell = '';
    let numericText = '';

    if (cells.length > 1) {
      const subjectIndex = cells.findIndex(cell =>
        /[a-z]{2,}/i.test(cell) && !/^(?:th|pr|pass|fail|ab|at|[a-f][+-]?)\.?$/i.test(cell)
      );
      if (subjectIndex >= 0) {
        subjectCell = cells[subjectIndex];
        numericText = cells.slice(subjectIndex + 1).join(' ');
      }
    }

    if (!subjectCell) {
      const textualRow = afterSerial.replace(/\|/g, ' ');
      const subjectMatch = textualRow.match(/^(.+?)(?=\s+(?:th|pr)\b|\s+\d|$)/i);
      if (!subjectMatch) continue;
      subjectCell = subjectMatch[1];
      numericText = textualRow.slice(subjectMatch[0].length);
    }

    const subject = cleanOcrSubject(subjectCell);
    if (!subject || subject.length < 4 || /\b(?:home|click|view|details|announced|date|register|father|mother|college|university)\b/i.test(subject)) continue;

    numericText = numericText.replace(/\b(?:th|pr|pass|fail|ab|at|[a-f][+-]?)\b\.?/ig, ' ');
    const numericTokens = numericText.match(/\d+(?:[.,]\d+)?/g) || [];
    const numericValues = numericTokens.map(token => Number(token.replace(',', '.')));
    const credits = numericValues[0];
    const gradePoint = numericValues[1];

    const key = subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      subject,
      credits: Number.isFinite(credits) && credits >= 0 && credits <= 10 ? credits : '',
      gradePoint: Number.isFinite(gradePoint) && gradePoint >= 0 && gradePoint <= 10 ? gradePoint : ''
    });
  }

  return rows;
}

function parseOcrText(lines) {
  const normalizedLines = lines
    .map(line => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (!normalizedLines.length) return [];

  const hasSubjectTableHeader = normalizedLines.some(line =>
    /\bsubject\s*name\b/i.test(line) ||
    (/\bsubject\b/i.test(line) && /\bname\b/i.test(line))
  );
  if (hasSubjectTableHeader) return parseSubjectTableLines(normalizedLines);

  const documentText = normalizedLines.join(' ').toLowerCase();
  const creditPointLayout =
    (documentText.includes('credit point') && documentText.includes('grade point')) ||
    ((documentText.match(/credit/g) || []).length >= 2 &&
      (documentText.match(/grade/g) || []).length >= 2 && documentText.includes('hours'));

  const seen = new Set();
  const rows = [];

  for (let index = 0; index < normalizedLines.length; index++) {
    const currentLine = normalizedLines[index];
    let candidate = currentLine;

    if (
      /[A-Za-z]/.test(currentLine) &&
      !/\d+(?:\.\d+)?\s+\d+(?:\.\d+)?/.test(currentLine) &&
      index + 1 < normalizedLines.length
    ) {
      const nextLine = normalizedLines[index + 1];
      if (/^\d[\d.\s+-]*$/.test(nextLine)) {
        candidate = `${currentLine} ${nextLine}`;
        index += 1;
      }
    }

    const row = parseLine(candidate, creditPointLayout);
    if (!row) continue;

    const key = row.subject.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  }

  return rows;
}

function addSubjectRow(row = { subject: '', credits: '', gradePoint: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="subject-input" aria-label="Subject name" placeholder="e.g. Mathematics"></td>
    <td><input class="number-input credits-input" aria-label="Credits" type="number" min="0" max="10" step="0.5" placeholder="0–10"></td>
    <td><input class="number-input grade-input" aria-label="Grade point" type="text" inputmode="decimal" pattern="(?:10(?:\\.0{1,2})?|[0-9](?:\\.\\d{1,2})?)" placeholder="0.00–10.00"></td>
    <td><button class="delete-button" type="button" aria-label="Delete subject" title="Delete row">×</button></td>`;
  tr.querySelector('.subject-input').value = row.subject ?? '';
  tr.querySelector('.credits-input').value = row.credits ?? '';
  const gradeInput = tr.querySelector('.grade-input');
  const gradePoint = row.gradePoint;
  gradeInput.value = gradePoint === '' || gradePoint === null || gradePoint === undefined
    ? ''
    : Number.isFinite(Number(gradePoint)) ? Number(gradePoint).toFixed(2) : String(gradePoint);
  gradeInput.addEventListener('blur', () => {
    const value = gradeInput.value.trim();
    if (value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10) {
      gradeInput.value = Number(value).toFixed(2);
    }
  });
  tr.querySelector('.delete-button').addEventListener('click', () => {
    tr.remove();
    resultsSection.classList.add('hidden');
  });
  tr.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
    input.classList.remove('invalid');
    resultsSection.classList.add('hidden');
  }));
  subjectRows.appendChild(tr);
}
document.getElementById('addRowButton').addEventListener('click', () => addSubjectRow());
addSubjectRow();

document.getElementById('calculateButton').addEventListener('click', () => {
  resultError.classList.add('hidden');
  const rows = [...subjectRows.querySelectorAll('tr')];
  const subjects = [];
  let problem = '';
  rows.forEach(tr => {
    const subjectInput = tr.querySelector('.subject-input');
    const creditsInput = tr.querySelector('.credits-input');
    const gradeInput = tr.querySelector('.grade-input');
    [subjectInput, creditsInput, gradeInput].forEach(input => input.classList.remove('invalid'));
    const subject = subjectInput.value.trim();
    const creditsRaw = creditsInput.value.trim();
    const gradeRaw = gradeInput.value.trim();
    if (!subject && !creditsRaw && !gradeRaw) return;
    const credits = Number(creditsRaw), gradePoint = Number(gradeRaw);
    if (!subject) { subjectInput.classList.add('invalid'); problem = 'Please enter a subject name for every completed row.'; }
    if (creditsRaw === '' || !Number.isFinite(credits) || credits < 0 || credits > 10) {
      creditsInput.classList.add('invalid'); problem = 'Every subject needs credits between 0 and 10.';
    }
    if (gradeRaw === '' || !/^(?:10(?:\.0{1,2})?|[0-9](?:\.\d{1,2})?)$/.test(gradeRaw) ||
        !Number.isFinite(gradePoint) || gradePoint < 0 || gradePoint > 10) {
      gradeInput.classList.add('invalid'); problem = 'Every subject needs a grade point between 0 and 10 with up to 2 decimal places.';
    }
    subjects.push({ subject, credits, gradePoint, creditsRaw, gradeRaw });
  });
  if (!subjects.length) problem = 'Please add at least one subject.';
  if (problem) {
    resultError.textContent = problem;
    resultError.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    return;
  }
  const totalCredits = subjects.reduce((sum, row) => sum + row.credits, 0);
  if (totalCredits === 0) {
    resultError.textContent = 'Total credits cannot be zero.';
    resultError.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    return;
  }
  const weightedPoints = subjects.reduce((sum, row) => sum + row.credits * row.gradePoint, 0);
  const gpa = weightedPoints / totalCredits;
  const percentage = Math.max(0, (gpa - 0.5) * 10);
  document.getElementById('gpaResult').textContent = gpa.toFixed(2);
  document.getElementById('percentageResult').textContent = `${percentage.toFixed(1)}%`;
  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
