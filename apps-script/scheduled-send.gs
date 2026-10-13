/**
 * Scheduled Send for Gmail - companion to the gmail-mcp draft_schedule tool.
 *
 * The Gmail API has no send-time option, so draft_schedule saves an ordinary
 * draft carrying an "X-Scheduled-Send: <UTC time>" header and the
 * Scheduled-Send label. This script runs inside the same Google account every
 * 5 minutes, finds drafts whose time has come, strips the header and sends them.
 *
 * ONE-TIME SETUP (per Google account, signed in as that account):
 *   1. script.google.com -> New project -> paste this whole file over Code.gs.
 *   2. Left sidebar: Services (+) -> Gmail API -> Add.
 *   3. Pick "install" in the function menu at the top, click Run, approve.
 * To stop it: run "uninstall".
 */

const HEADER = 'X-Scheduled-Send';
const LABEL = 'Scheduled-Send';
const FAILED_LABEL = 'Scheduled-Send/Failed';
// Who gets a failure alert. Blank = this account itself.
const ALERT_TO = '';
// A full scan of every draft runs this often, as a backstop for any draft
// whose label failed to apply. The 5-minute runs search the label only.
const FULL_SCAN_MINUTES = 60;
// A send interrupted part-way (script killed) is reported after this long.
const INFLIGHT_ALERT_MINUTES = 15;

function install() {
  uninstall();
  ScriptApp.newTrigger('sendDue').timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().deleteProperty('lastFullScan');
  sendDue();
  Logger.log('Installed. Checking every 5 minutes as ' + Session.getEffectiveUser().getEmail());
}

function uninstall() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendDue'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function sendDue() {
  // Two overlapping runs could otherwise both send the same draft.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return;
  }
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  checkInflight_(props, now);

  const lastFull = Number(props.getProperty('lastFullScan') || 0);
  const fullScan = now - lastFull > FULL_SCAN_MINUTES * 60000;
  const labelled = listDrafts_('label:' + LABEL);
  const drafts = fullScan ? listDrafts_(undefined) : labelled;
  if (fullScan) {
    props.setProperty('lastFullScan', String(now));
  }
  const labelledIds = {};
  labelled.forEach(function (d) { labelledIds[d.id] = true; });

  drafts.forEach(function (d) {
    if (!d.message || !d.message.id) {
      return;
    }
    const meta = Gmail.Users.Messages.get('me', d.message.id, {format: 'metadata', metadataHeaders: [HEADER, 'Subject']});
    const headers = (meta.payload && meta.payload.headers) || [];
    const marker = findHeader_(headers, HEADER);
    const subject = findHeader_(headers, 'Subject') || '(no subject)';

    if (!marker) {
      // Labelled but no send time: usually the draft was edited in Gmail,
      // which can drop custom headers. It will never send on its own.
      if (labelledIds[d.id]) {
        alertOnce_(props, 'nomarker:' + d.id + ':' + d.message.id,
          'Scheduled email lost its send time: ' + subject,
          'The draft "' + subject + '" still has the ' + LABEL + ' label but no send time, so it will not send. '
          + 'Ask Claude to reschedule it (scheduled_update), or send it from Gmail.');
      }
      return;
    }

    const when = new Date(marker);
    if (isNaN(when.getTime()) || when.getTime() > now) {
      return;
    }
    if (props.getProperty('failed:' + d.id) === marker) {
      return; // already failed at this time and alerted; a reschedule retries it
    }
    sendOne_(props, d.id, marker, subject);
  });
}

function sendOne_(props, draftId, marker, subject) {
  const inflightKey = 'inflight:' + draftId;
  let original = null;
  let threadId = null;
  try {
    const draft = Gmail.Users.Drafts.get('me', draftId, {format: 'raw'});
    original = rawToString_(draft.message.raw);
    threadId = draft.message.threadId;
    const stripped = setMarker_(original, null);

    props.setProperty(inflightKey, JSON.stringify({at: Date.now(), subject: subject}));
    Gmail.Users.Drafts.update(
      {id: draftId, message: {raw: Utilities.base64EncodeWebSafe(stripped, Utilities.Charset.UTF_8), threadId: threadId}},
      'me', draftId);
    const sent = Gmail.Users.Drafts.send({id: draftId}, 'me');
    props.deleteProperty(inflightKey);
    removeLabel_(sent.id);
  } catch (e) {
    props.deleteProperty(inflightKey);
    props.setProperty('failed:' + draftId, marker);
    // Put the send time back so the draft stays visible as overdue (Claude's
    // scheduled_list and the morning check both flag it) instead of becoming
    // a plain draft nobody is watching.
    if (original !== null) {
      try {
        const restored = Gmail.Users.Drafts.update(
          {id: draftId, message: {raw: Utilities.base64EncodeWebSafe(original, Utilities.Charset.UTF_8), threadId: threadId}},
          'me', draftId);
        addLabel_(restored.message.id, FAILED_LABEL);
      } catch (ignored) {
        // The alert below still goes out.
      }
    }
    alert_('Scheduled email FAILED to send: ' + subject,
      'The scheduled email "' + subject + '" (due ' + marker + ') could not be sent.\n\nError: ' + e
      + '\n\nIt is still in Drafts. Send it from Gmail, or ask Claude to reschedule it.');
  }
}

function checkInflight_(props, now) {
  const all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('inflight:') !== 0) {
      return;
    }
    const info = JSON.parse(all[key]);
    if (now - info.at > INFLIGHT_ALERT_MINUTES * 60000) {
      props.deleteProperty(key);
      alert_('Scheduled email may not have sent: ' + info.subject,
        'A send of "' + info.subject + '" was interrupted part-way. Check Sent and Drafts in Gmail.');
    }
  });
}

function listDrafts_(q) {
  const out = [];
  let pageToken;
  do {
    const args = {maxResults: 100};
    if (q) {
      args.q = q;
    }
    if (pageToken) {
      args.pageToken = pageToken;
    }
    const page = Gmail.Users.Drafts.list('me', args);
    (page.drafts || []).forEach(function (d) { out.push(d); });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

function findHeader_(headers, name) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].name.toLowerCase() === name.toLowerCase()) {
      return String(headers[i].value).trim();
    }
  }
  return null;
}

// The advanced service may hand back raw as web-safe base64 text or as bytes.
function rawToString_(raw) {
  if (typeof raw === 'string') {
    let s = raw;
    while (s.length % 4) {
      s += '=';
    }
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
  }
  return Utilities.newBlob(raw).getDataAsString('UTF-8');
}

// Mirrors setScheduleMarker in src/utils/schedule.ts: header block only,
// folded continuation lines included, body untouched.
function setMarker_(message, whenIso) {
  const sep = /\r?\n\r?\n/.exec(message);
  const headEnd = sep ? sep.index : message.length;
  const head = message.slice(0, headEnd);
  const rest = message.slice(headEnd);
  const prefix = HEADER.toLowerCase() + ':';
  const kept = [];
  let dropping = false;
  head.split(/\r?\n/).forEach(function (line) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) {
        kept.push(line);
      }
      return;
    }
    dropping = line.toLowerCase().indexOf(prefix) === 0;
    if (!dropping) {
      kept.push(line);
    }
  });
  if (whenIso) {
    kept.unshift(HEADER + ': ' + whenIso);
  }
  return kept.join('\r\n') + rest;
}

function labelId_(name, create) {
  const labels = Gmail.Users.Labels.list('me').labels || [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].name === name) {
      return labels[i].id;
    }
  }
  return create ? Gmail.Users.Labels.create({name: name}, 'me').id : null;
}

function removeLabel_(messageId) {
  try {
    const id = labelId_(LABEL, false);
    if (id) {
      Gmail.Users.Messages.modify({removeLabelIds: [id]}, 'me', messageId);
    }
  } catch (ignored) {
    // Cosmetic only; the email has already gone out.
  }
}

function addLabel_(messageId, name) {
  Gmail.Users.Messages.modify({addLabelIds: [labelId_(name, true)]}, 'me', messageId);
}

function alert_(subject, body) {
  MailApp.sendEmail(ALERT_TO || Session.getEffectiveUser().getEmail(), subject, body);
}

function alertOnce_(props, key, subject, body) {
  if (props.getProperty(key)) {
    return;
  }
  props.setProperty(key, '1');
  alert_(subject, body);
}
