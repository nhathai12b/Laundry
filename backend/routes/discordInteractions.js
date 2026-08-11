import crypto from 'crypto';
import express from 'express';
import { handleBemyCommand } from '../services/discordCommandService.js';

const router = express.Router();

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
};

const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
};

function getEd25519PublicKey(publicKeyHex) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const publicKey = Buffer.from(publicKeyHex, 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, publicKey]),
    format: 'der',
    type: 'spki',
  });
}

function verifyDiscordSignature(req) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex) return false;

  const signature = req.get('x-signature-ed25519');
  const timestamp = req.get('x-signature-timestamp');
  const rawBody = req.rawBody;

  if (!signature || !timestamp || !rawBody) return false;

  try {
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      getEd25519PublicKey(publicKeyHex),
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    console.warn('Discord signature verification failed:', error.message);
    return false;
  }
}

function commandResponse(content) {
  return {
    type: RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      allowed_mentions: { parse: [] },
    },
  };
}

router.post('/interactions', async (req, res) => {
  try {
    if (!verifyDiscordSignature(req)) {
      return res.status(401).send('Invalid request signature');
    }

    const interaction = req.body;

    if (interaction.type === INTERACTION_TYPE.PING) {
      return res.json({ type: RESPONSE_TYPE.PONG });
    }

    if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) {
      return res.json(commandResponse('Interaction type chưa được hỗ trợ.'));
    }

    if (interaction.data?.name !== 'bemy') {
      return res.json(commandResponse('Command chưa được hỗ trợ.'));
    }

    const content = await handleBemyCommand(interaction);
    return res.json(commandResponse(content));
  } catch (error) {
    console.error('Discord interaction error:', error);
    return res.json(commandResponse('Không thể lấy báo cáo doanh thu lúc này.'));
  }
});

export default router;
