'use strict';

const { parseDiff, chunkFiles } = require('../diffParser');
const { scanFile, sortFindings, dedupeFindings } = require('../rules');

const CHUNK_BYTES = 65536;

async function processMockJob(job) {
  job.setStatus('running');
  try {
    const { files, totalBytes } = parseDiff(job.diff);
    const chunks = chunkFiles(files, CHUNK_BYTES);

    job.usage.inputBytes = totalBytes;
    job.usage.chunks = chunks.length;

    let allFindings = [];
    for (const chunk of chunks) {
      for (const file of chunk) {
        allFindings.push(...scanFile(file));
      }
    }

    allFindings = sortFindings(dedupeFindings(allFindings));

    const maxFindings = Number.isInteger(job.options && job.options.maxFindings)
      ? job.options.maxFindings
      : 100;
    const truncated = allFindings.slice(0, Math.max(0, maxFindings));

    for (const finding of truncated) {
      job.addFinding(finding);
      // Yield to the event loop between findings so SSE subscribers observe
      // them as discrete, ordered events rather than one synchronous burst.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }

    job.finishDone();
  } catch (err) {
    job.finishFailed(err && err.message ? err.message : 'internal error during mock scan');
  }
}

module.exports = { processMockJob, CHUNK_BYTES };
