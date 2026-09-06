const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("..");

function buildStallFixture() {
  const jobs = new Map();
  const specs = new Map();
  const spawned = [];
  const removed = [];
  const stopped = [];
  const retryTimers = [];
  const createJob = (type, title, meta = {}) => {
    const job = core.createJobRecord(type, title, meta, { id: `job-${jobs.size + 1}` });
    jobs.set(job.id, job);
    return job;
  };
  const controller = core.createDownloadJobController({
    jobs,
    downloadSpecs: specs,
    createJob,
    processStartedAt: Date.now() - 60_000,
    autoRetryCount: 2,
    autoRetryDelaySeconds: 1,
    spawnJobProcess: (job, command, args, options) => {
      job.status = "running";
      job.command = command;
      job.args = args;
      job.spawnOptions = options;
      spawned.push(job.id);
    },
    buildDownloadSpecFromJob: (job) => ({
      command: "hf",
      args: ["download", job.meta.model],
      options: { meta: { ...job.meta }, title: job.title },
    }),
    appendLog: (job, data) => {
      job.logs = [...(job.logs || []), String(data)];
    },
    stopProgressTracker: (job) => stopped.push(job.id),
    scheduleSave: () => {},
    getQueueMode: () => false,
    setQueueMode: () => {},
    saveQueueMode: async () => {},
    resolvePartialPath: (value) => value,
    removePartialPath: async (target) => {
      removed.push(target);
    },
    setRetryTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      retryTimers.push(timer);
      return timer;
    },
    clearRetryTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  return { jobs, specs, spawned, removed, stopped, retryTimers, createJob, controller };
}

test("download stall preserves partial files and schedules auto retry", async () => {
  const { spawned, removed, stopped, retryTimers, controller } = buildStallFixture();

  const job = controller.enqueueOrStartDownload("hf", ["download", "org/model"], {
    title: "Download org/model",
    meta: { model: "org/model", localDir: "partial-dir" },
  });
  assert.equal(job.status, "running");
  assert.deepEqual(spawned, ["job-1"]);

  // Progress tracker detects a stall: cancel("stall") marks the intent, the
  // child exits, and the manager routes the close into the stall handler.
  core.markJobCancelRequested(job, "stall");
  controller.handleDownloadStallAfterStop(job);

  assert.equal(job.status, "failed", "stall must fail the job, not cancel it");
  assert.equal(job.meta.cancelRequested, false);
  assert.equal(job.meta.cancelAction, null);
  assert.ok(job.meta.failedAt >= controller.processStartedAt, "failedAt must be fresh so retries are not skipped as stale");
  assert.deepEqual(removed, [], "partial download files must never be deleted on stall");
  assert.ok(stopped.includes(job.id), "progress tracker must be stopped");

  // handleDownloadStallAfterStop drains via setImmediate; let it run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryTimers.length, 1, "a retry must be scheduled for the stalled download");
  assert.ok(job.meta.retryScheduledAt, "retry schedule must be recorded on the job");

  // Fire the retry: the download resumes from local bytes instead of restarting.
  retryTimers[0].fn();
  assert.equal(job.status, "running");
  assert.equal(job.meta.retryCount, 1);
  assert.deepEqual(spawned, ["job-1", "job-1"]);
  assert.deepEqual(removed, [], "resume after stall must not delete local files either");
});

test("user cancellation and network stalls both preserve downloaded files", async () => {
  const { removed, controller, createJob } = buildStallFixture();
  const job = createJob("download", "Download org/other", { model: "org/other", localDir: "partial-other" });
  job.status = "failed";
  await controller.cancelDownloadJob(job);
  assert.equal(job.status, "cancelled");
  assert.deepEqual(removed, [], "cancellation never recursively deletes the download directory");
});
