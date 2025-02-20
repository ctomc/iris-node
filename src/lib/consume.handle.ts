import * as amqplib from 'amqplib'
import * as message from './message'
import * as messageHandler from './message_handler'
import { getLogger } from '../logger'
import * as publish from './publish'
import * as classTransformer from 'class-transformer'
import * as errors from './errors'
import * as amqpHelper from './amqp.helper'
import * as consumeAck from './consume.ack'
import * as consumeError from './consume.error'
import * as _ from 'lodash'

const logger = getLogger('Iris:ConsumerHandle')

type ResolveMessageHandlerI = (msg: amqplib.ConsumeMessage) => messageHandler.ProcessedMessageHandlerMetadataI

type HandleMessageT = {
  resolveMessageHandler: ResolveMessageHandlerI
  obtainChannel: () => Promise<amqplib.Channel>
  queueName: string
  onChannelClose: () => void
  msgMeta: message.ProcessedMessageMetadataI
}

type HandleMessageReturnT = (msg: amqplib.ConsumeMessage | null) => Promise<void>

export function getMessageHandler({ resolveMessageHandler, obtainChannel, queueName, onChannelClose, msgMeta }: HandleMessageT): HandleMessageReturnT {
  return async (msg: amqplib.ConsumeMessage | null): Promise<void> => {
    if (msg === null) {
      logger.warn(`Received empty message on queue "${queueName}" (disappeared?)`)
      onChannelClose()

      return
    }

    const ch = await obtainChannel()
    logger.debug('Message received for exchange', {
      queueName,
      message: msg.content.toString(),
      fields: msg.fields,
      headers: <undefined | object>amqpHelper.safeAmqpObjectForLogging(msg.properties.headers) ?? '<missing headers>',
    })

    if (consumeAck.ignoreMsg(msg, ch)) {
      logger.debug('Ignoring message')

      return
    }

    if (_.isNil(msg.properties.headers)) {
      logger.warn('Received message with no headers. Assigning empty object.')
      msg.properties.headers = {}
    }

    const handler = resolveMessageHandler(msg)

    try {
      const result: unknown = await handler.callback(msg)
      consumeAck.safeAckMsg(msg, ch, 'ack')

      if (handler.kind === 'WITH_REPLY' && result !== undefined) {
        await publish.publishReply(msg, <classTransformer.ClassConstructor<unknown>>handler.replyMessageClass, result).catch(e => {
          logger.error('Publish reply failed', <Error>e, errors.enhancedDetails({ result }, <Error>e))
        })
      }
    } catch (e) {
      await consumeError.handleConsumeError(<Error>e, handler, msgMeta, ch, msg)
    }
  }
}
