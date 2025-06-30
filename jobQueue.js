const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required for Upstash
});

const documentQueue = new Queue('document-processing', { connection });

module.exports = { documentQueue };
