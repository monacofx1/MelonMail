import sha3 from 'solidity-sha3';
import uniqBy from 'lodash/uniqBy';

import ipfs from '../services/ipfsService';
import eth from '../services/ethereumService';
import { decrypt } from '../services/cryptoService';
import { closeCompose } from './compose';

export const mailRequest = () => ({
  type: 'MAIL_REQUEST',
});

export const mailSuccess = (thread, threadHash, threadId) => ({
  type: 'MAIL_SUCCESS',
  thread,
  threadHash,
  threadId,
});

export const mailError = error => ({
  type: 'MAIL_ERROR',
  error,
});

export const getThread = (threadId, afterBlock) => (dispatch, getState) => {
  dispatch(mailRequest());
  const keys = {
    publicKey: getState().user.publicKey,
    privateKey: getState().user.privateKey,
  };
  eth.getThread(threadId, afterBlock)
    .then(threadEvent => (
      ipfs.getThread(threadEvent.args.threadHash)
        .then((thread) => {
          const mailLinks = thread.toJSON().links;

          const ipfsFetchPromises = mailLinks.map(mailLink =>
            ipfs.getFileContent(mailLink.multihash));

          Promise.all(ipfsFetchPromises)
            .then((mails) => {
              const decryptedMails = mails.map((mail, index) => {
                const mailToDecrypt = JSON.parse(mail);
                const mailBody = mailToDecrypt.toAddress === eth.getAccount() ?
                  mailToDecrypt.receiverData : mailToDecrypt.senderData;
                return {
                  ...JSON.parse(decrypt(keys, mailBody)),
                  hash: mailLinks[index].multihash,
                };
              });

              dispatch(mailSuccess(decryptedMails, threadEvent.args.threadHash, threadId));
            })
            .catch((error) => {
              console.log(error);
              dispatch(mailError(error.message));
            });
        })
    ))
    .catch((error) => {
      console.log(error);
      dispatch(mailError(error.message));
    });
};

export const sendMail = (mail, threadId) => (dispatch, getState) => {
  ipfs.uploadMail(mail)
    .then((mailLink) => {
      const mailObject = mailLink.length ? mailLink[0] : mailLink;
      if (threadId) {
        const threadHash = getState().mail.threadHash;
        ipfs.replyToThread(mailObject, threadHash)
          .then((threadLink) => {
            const multihash = threadLink.toJSON().multihash;
            return eth._sendEmail(mail.toAddress, mailObject.hash, multihash, threadId);
          });
      } else {
        ipfs.newThread(mailObject)
          .then((threadLink) => {
            const multihash = threadLink.toJSON().multihash;
            dispatch(closeCompose());
            return eth._sendEmail(mail.toAddress, mailObject.hash, multihash, sha3(multihash));
          });
      }
    })
    .catch((error) => {
      console.log(error);
    });
};

export const changeMailsFolder = folder => ({
  type: 'MAILS_FOLDER_CHANGE',
  folder,
});

export const mailsRequest = mailType => (
  mailType === 'inbox' ?
    { type: 'MAILS_INBOX_REQUEST' } :
    { type: 'MAILS_OUTBOX_REQUEST' }
);

export const mailsSuccess = (mailType, mails, fetchedFromBlock) => (
  mailType === 'inbox' ?
    { type: 'MAILS_INBOX_SUCCESS', mails, fetchedFromBlock } :
    { type: 'MAILS_OUTBOX_SUCCESS', mails, fetchedFromBlock }
);

export const mailsError = (mailType, error) => (
  mailType === 'inbox' ?
    { type: 'MAILS_INBOX_ERROR', error } :
    { type: 'MAILS_OUTBOX_ERROR', error }
);

export const newMail = (mailType, mails) => (
  mailType === 'inbox' ?
    { type: 'NEW_INBOX_MAIL', mails } :
    { type: 'NEW_OUTBOX_MAIL', mails }
);

export const mailsNoMore = () => ({
  type: 'MAILS_NO_MORE',
});

export const getMails = folder => (dispatch, getState) => {
  const userStartingBlock = getState().user.startingBlock;
  const keys = {
    publicKey: getState().user.publicKey,
    privateKey: getState().user.privateKey,
  };
  const fetchToBlock = folder === 'inbox' ?
    getState().mails.inboxFetchedFromBlock : getState().mails.outboxFetchedFromBlock;
  const blocksInBatch = folder === 'inbox' ?
    getState().mails.inboxBatchSize : getState().mails.outboxBatchSize;
  if (fetchToBlock !== null && fetchToBlock <= userStartingBlock) {
    dispatch(mailsNoMore());
    return;
  }
  dispatch(mailsRequest(folder));
  eth.getMails(folder, fetchToBlock, blocksInBatch, userStartingBlock)
    .then((res) => {
      const { mailEvents, fromBlock } = res;
      const ipfsFetchPromises = mailEvents.map(mail => ipfs.getFileContent(mail.args.mailHash));

      return Promise.all(ipfsFetchPromises)
        .then((mails) => {
          const decryptedMails = mails.map((mail, index) => {
            const mailToDecrypt = JSON.parse(mail);
            const mailBody = folder === 'inbox' ? mailToDecrypt.receiverData : mailToDecrypt.senderData;
            return {
              transactionHash: mailEvents[index].transactionHash,
              blockNumber: mailEvents[index].blockNumber,
              ...mailEvents[index].args,
              ...JSON.parse(decrypt(keys, mailBody)),
            };
          });
          const newMailsState = [...getState().mails[folder], ...decryptedMails];
          dispatch(mailsSuccess(folder, uniqBy(newMailsState, 'threadId'), fromBlock));
        })
        .catch((error) => {
          console.log(error);
          dispatch(mailsError(folder, error));
        });
    })
    .catch((error) => {
      console.log(error);
      dispatch(mailsError(folder, error));
    });
};

export const listenForMails = () => (dispatch, getState) => {
  console.log('listening for mail');
  eth.listenForMails((mailEvent, mailType) => {
    ipfs.getFileContent(mailEvent.args.mailHash)
      .then((ipfsContent) => {
        const encryptedMail = JSON.parse(ipfsContent);
        const mailContent = mailType === 'inbox' ?
          encryptedMail.receiverData : encryptedMail.senderData;
        const keys = {
          publicKey: getState().user.publicKey,
          privateKey: getState().user.privateKey,
        };
        const mail = {
          transactionHash: mailEvent.transactionHash,
          blockNumber: mailEvent.blockNumber,
          ...mailEvent.args,
          ...JSON.parse(decrypt(keys, mailContent)),
        };

        if (mailType === 'inbox') {
          const mails = [mail, ...getState().mails.inbox];
          dispatch(newMail('inbox', uniqBy(mails, 'threadId')));
        } else {
          const mails = [mail, ...getState().mails.outbox];
          dispatch(newMail('outbox', uniqBy(mails, 'threadId')));
        }
        console.log(mailContent);
      });
  });
};
