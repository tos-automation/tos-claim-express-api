// jobQueue.js
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.UPSTASH_REDIS_REST_URL, {
  password: process.env.UPSTASH_REST_TOKEN,
  tls: true, // required for Upstash HTTPS
});

const documentQueue = new Queue('document-processing', { connection });

module.exports = { documentQueue };
