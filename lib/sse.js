'use strict';

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Streams a job's events over SSE. Always replays every event recorded so
 * far (so reconnecting to a finished job replays it identically), then, if
 * the job isn't finished yet, keeps the connection open and forwards new
 * events live until `done`.
 */
function streamJob(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  for (const { event, data } of job.events) {
    writeSseEvent(res, event, data);
  }

  if (job.status === 'done' || job.status === 'failed') {
    res.end();
    return;
  }

  const cleanup = () => {
    job.emitter.removeListener('event', listener);
  };

  const listener = ({ event, data }) => {
    writeSseEvent(res, event, data);
    if (event === 'done') {
      cleanup();
      res.end();
    }
  };

  job.emitter.on('event', listener);
  req.on('close', cleanup);
}

module.exports = { streamJob, writeSseEvent };
