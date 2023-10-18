const moment = require('moment');
const options = {
  sayOptions: { voice: 'Polly.Joanna' },
};

// Global Variables for caching
let stats = {};
let queueConfig = {};
let cachedTimestamp = null;
let taskQueueName = null;

/**
 * This function takes average EWT as a param
 * and returns the same in duration as Hours, as minutes and as seconds.
 */
function getAverageWaitTimeDuration(t) {
  const durationInSeconds = moment.duration(t.avg, 'seconds');

  return {
    type: 'avgWaitTime',
    hours: durationInSeconds.asHours(),
    minutes: durationInSeconds.asMinutes(),
    seconds: durationInSeconds.asSeconds(),
  };
}

/**
 * This functions takes the cumulative statistics fetched from TR API
 * and returns EWT in minutes along with wait message that is played to the customer
 */
function generateEwtMessage(stats) {
  const t = stats?.cumulativeStats?.waitDurationUntilAccepted;
  durationObject = getAverageWaitTimeDuration(t);
  ewtHours = Math.floor(durationObject.hours);
  ewtMinutes = Math.floor(durationObject.minutes);
  ewtSeconds = Math.floor(durationObject.seconds);
  let waitMsg = '';
  let timeObject = new Date(null);
  timeObject.setSeconds(ewtSeconds);
  let formattedTime = timeObject.toISOString().slice(11, 19).split(':');
  let formattedHours = Math.trunc(Number(formattedTime[0]));
  let formattedMin = Math.trunc(Number(formattedTime[1]));

  if (ewtSeconds < 60) {
    waitTts = 'less than a minute';
  } else if (ewtSeconds >= 60 && ewtMinutes < 60) {
    waitTts = `${ewtMinutes} ${formattedMin === 1 ? 'minute' : 'minutes'}`;
  } else {
    formattedHours < 2
      ? (waitTts = `${formattedHours} hour ${formattedMin} ${formattedMin === 1 ? 'minute' : 'minutes'}`)
      : (waitTts = `${formattedHours} hours ${formattedMin} ${formattedMin === 1 ? 'minute' : 'minutes'}`);
  }
  waitMsg += `The estimated wait time is ${waitTts}....`;

  return { waitMsg, ewt: ewtMinutes };
}

const TaskRouterOperations = require(Runtime.getFunctions()['common/twilio-wrappers/taskrouter'].path);

const SyncOperations = require(Runtime.getFunctions()['common/twilio-wrappers/sync'].path);

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  let directLine;
  event.directLine ? (directLine = JSON.parse(event.directLine)) : (directLine = false);
  if (directLine) {
    console.log(event.Caller, event.QueueTime);
    if (Number(event.QueueTime) < 30) {
      twiml.play('https://pistachio-butterfly-4890.twil.io/assets/sample-12s.mp3');
    } else {
      twiml.say('Our agents are busy right now. Please try after sometime');
      twiml.hangup();
    }
    callback(null, twiml);
  } else {
    try {
      const ONE_MINUTE = 60 * 1000;
      let callbackConfigOnTaskqueue;
      let ewt;
      let inOperatingHours;

      // If the cached stats or queueConfig were not successful, or if the taskqueue was not cached
      // or if cached taskqueue is not the same as the current taskqueue or if the stats and queueConfig
      // were not cached, fetch new values
      if (
        !stats?.success ||
        !queueConfig?.success ||
        taskQueueName === null ||
        taskQueueName !== event?.taskQueueName ||
        JSON.stringify(stats) === '{}' ||
        JSON.stringify(queueConfig) === '{}' ||
        cachedTimestamp === null
      ) {
        taskQueueName = event?.taskQueueName;

        stats = await TaskRouterOperations.getQueuesStats({
          context,
          taskQueueName,
        });

        taskQueueSid = stats?.cumulativeStats?.taskQueueSid;

        queueConfig = await SyncOperations.getTaskqueueConfig({
          context,
          taskQueueSid,
        });

        cachedTimestamp = Date.now();
      } else {
        // If the stats were cached, check if they are older than one minute
        // if yes, fetch new values else use the same ones.
        const durationFromLastUpdate = Date.now() - cachedTimestamp;
        if (durationFromLastUpdate > ONE_MINUTE) {
          taskQueueName = event?.taskQueueName;

          stats = await TaskRouterOperations.getQueuesStats({
            context,
            taskQueueName,
          });

          taskQueueSid = stats?.cumulativeStats?.taskQueueSid;

          queueConfig = await SyncOperations.getTaskqueueConfig({
            context,
            taskQueueSid,
          });

          cachedTimestamp = Date.now();
        }
      }

      // If ewtEnabled query param was not received by gatekeeper,
      // set it to false
      event.ewtEnabled ? (ewtEnabled = JSON.parse(event.ewtEnabled)) : (ewtEnabled = false);

      // If presentCallback query param was not received by gatekeeper,
      // set it to false
      event.presentCallback ? (inOperatingHours = JSON.parse(event.presentCallback)) : (inOperatingHours = false);

      // Create EWT message and EWT
      let generateEwtMessageResponse = generateEwtMessage(stats);

      // If queueConfig was not fetched successfully, set it to false
      !queueConfig?.success
        ? (callbackConfigOnTaskqueue = false)
        : (callbackConfigOnTaskqueue = queueConfig?.taskQueueConfig?.callback_enabled);

      // If there was an error in gettint ewt in minutes, set it to 0
      !generateEwtMessageResponse.ewt ? (ewt = 0) : (ewt = generateEwtMessageResponse.ewt);

      if (ewtEnabled && generateEwtMessageResponse.waitMsg) {
        twiml.say(options.sayOptions, generateEwtMessageResponse.waitMsg);
      }
      if (callbackConfigOnTaskqueue && inOperatingHours) {
        if (ewt > context.EWT_THRESHOLD_FOR_PRESENTING_CALLBACK) {
          twiml.redirect(
            //   `https://${context.DOMAIN_NAME}/features/callback-and-voicemail/studio/wait-experience?mode=opt-out-choice&QueueSid=${event.QueueSid}&CallSid=${event.CallSid}`,
            `https://c466-2405-201-d00b-18e1-5d66-87af-afc3-7bb7.ngrok-free.app/features/callback-and-voicemail/studio/wait-experience?mode=opt-out-choice&QueueSid=${event.QueueSid}&CallSid=${event.CallSid}`,
          );
        } else {
          twiml.redirect('https://handler.twilio.com/twiml/EHb4bbd2cdb6e6d182944f4b069bef8404');
        }
      } else {
        twiml.redirect('https://handler.twilio.com/twiml/EHb4bbd2cdb6e6d182944f4b069bef8404');
      }

      callback(null, twiml);
    } catch (error) {
      console.error('Failed to process gatekeeper function with the error: ', error);
      twiml.redirect('https://handler.twilio.com/twiml/EHb4bbd2cdb6e6d182944f4b069bef8404');
      callback(null, twiml);
    }
  }
};
