const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL);

const documentQueue = new Queue('document-processing', { connection });

module.exports = { documentQueue };
