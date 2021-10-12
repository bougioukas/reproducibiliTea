/*
* Script to update journal clubs. Designed for use on Amazon Web Services as a
* scheduled function.
*
* The script does the following:
* 1. Query GitHub for active journal clubs
* 2. Select the JC updated least recently
* 3. Check whether the JC owners need to be prompted to update
* 4. Send the appropriate emails if any
* 5. Update the JC to mark the last email sent
*/

// node fetch support
const fetch = require("node-fetch");
require('dotenv').config();

let {GITHUB_REPO_API} = process.env;

const {
    GITHUB_API_USER,
    GITHUB_TOKEN,
    MAILGUN_API_KEY,
    MAILGUN_DOMAIN,
    MAILGUN_HOST,
    FROM_EMAIL_ADDRESS
} = process.env;

const MESSAGE_LEVELS = {
    UP_TO_DATE: 0,
    NOTIFICATION: 1,
    FIRST_REMINDER: 2,
    SECOND_REMINDER: 3,
    JC_DEACTIVATED: 4
};

const ACTIONS = {
    "action-1": "Notification sent.",
    "action-2": "First reminder sent.",
    "action-3": "Second reminder sent",
    "action-4": "Journal club deactivated."
};

const MAX_DAYS_SINCE_UPDATE = 365;
const MIN_DAYS_BETWEEN_EMAILS = 28;

const TOO_OLD = new Date()
    .setDate(new Date().getDate() - MAX_DAYS_SINCE_UPDATE);
const TOO_RECENT = new Date()
    .setDate(new Date().getDate() - MIN_DAYS_BETWEEN_EMAILS);

let SANDBOX = true;

exports.handler = function(event, context, callback) {
    SANDBOX = /^localhost(?::[0-9]+$|$)/i.test(event.headers.host) || event.queryStringParameters.sandbox;
    if(SANDBOX)
        GITHUB_REPO_API = process.env.GITHUB_REPO_API_SANDBOX;
    rollcall()
        .then(summary => {
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(summary)
            });
        })
        .catch(e => callback(e));
};

/**
 * @class Rollcall result
 * @classdesc Contains the details of a rollcall result
 *
 * @property journalClub {object} journal club the result pertains to
 * @property action {string} action taken by the rollcall
 */
class RollcallResult {
    constructor(JC, action) {
        this.journalClub = JC;
        this.action = action;
    }
}

/**
 * @class Journal club
 * @classdesc parsed and raw journal club information
 *
 * @property gitHubResponse {object} gitHub JC query response
 * @property lastUpdate {Date} last time the JC was updated
 * @property lastMessage {Date} last time a message was sent
 * @property lastMessageLevel {int} severity level of the last message
 * @property contactEmails {string[]} contact email addresses
 * @property title {string} journal club title
 * @property jcid {string} journal club id
 * @property token {string} journal club edit token
 */
class JournalClub {
    constructor(gitHubResponse) {
        this.gitHubResponse = gitHubResponse;
        this.parseContent();
    }

    /**
     * Fetch the decoded string content of this JC's md file
     * @return {string}
     */
    get content() {
        return new Buffer.from(this.gitHubResponse.content, 'base64').toString();
    }

    /**
     * Extract the relevant content information from a journal club file
     */
     parseContent() {

        // Hack out the bits of the results we need
        const lastUpdate = /^last-update-timestamp: (.*)$/m.exec(this.content);
        const lastMessage = /^last-message-timestamp: (.*)$/m.exec(this.content);
        const lastMessageLevel = /^last-message-level: (.*)$/m.exec(this.content);
        const jcid = /^jcid: (.*)$/m.exec(this.content);
        const title = /^title: (.*)$/m.exec(this.content);
        const contact = /^contact: (.*)$/m.exec(this.content);
        const additionalContacts = /^additional-contact: (.*)$/m.exec(this.content);
        this.lastUpdate = lastUpdate? new Date(parseInt(lastUpdate[1]) * 1000) : new Date(0);
        this.lastMessage = lastMessage? new Date(parseInt(lastMessage[1]) * 1000) : new Date(0);
        this.lastMessageLevel = lastMessageLevel? parseInt(lastMessageLevel[1]) : MESSAGE_LEVELS.UP_TO_DATE;
        this.jcid = jcid? jcid[1] : null;
        this.title = title? title[1] : null;
        this.contactEmails = [contact? contact[1] : ""];
        if(additionalContacts !== null) {
            this.contactEmails = [
                ...this.contactEmails,
                ...additionalContacts[1].split(', ')
            ];
        }
    }

    /**
     * @return {int} flag representing the new message level
     */
    get newMessageLevel() {
         return this.lastMessageLevel + 1;
    }
}

/**
 * Perform a rollcall on each Journal Club.
 * A rollcall sends out an email to journal club contacts who have not updated
 * their journal club in the last year.
 * Thereafter, increasingly strident requests for checking in are sent each
 * month for two months.
 * If a journal club is not updated for 15 months it is marked as lapsed.
 * @return {RollcallResult[]}
 */
async function rollcall() {
     const JC = await getOldestJC();
     if(JC === null)
         return "Rollcall: All JCs okay.";
     const rc = await processRollcall(JC);
     return `Rollcall: ${rc.journalClub.jcid} -- ${rc.action}`;
}

/**
 * Send appropriate emails and deactivate JC if required.
 * @param JC {JournalClub}
 * @return {RollCallResult}
 */
async function processRollcall(JC) {
    const template = await fetch(
        `${GITHUB_REPO_API}/contents/_emails/rollcall-message-${JC.newMessageLevel}.json`,
        {
            headers: {
                'User-Agent': GITHUB_API_USER,
                Authorization: `token ${GITHUB_TOKEN}`
            }
        }
    )
        .then(r => r.json())
        .then(json => new Buffer.from(json.content, 'base64').toString())
        .then(s => JSON.parse(s));

    // Update the template into a proper email
    const email = substituteHandlebars(
        template,
        {jcTitle: JC.title}
    );

    let action = ACTIONS[`action-${JC.newMessageLevel}`];
    if(JC.newMessageLevel === MESSAGE_LEVELS.JC_DEACTIVATED)
        JC.contactEmails.push(FROM_EMAIL_ADDRESS); // cc RpT for deactivations
    let updateFailed = "";

    // Send the email
    const emailFailed = await sendEmail(JC.contactEmails, email.subject, email.body);

    if(!emailFailed) {
        // Trigger other actions
        if(JC.newMessageLevel === MESSAGE_LEVELS.JC_DEACTIVATED)
            updateFailed = await deactivateJC(JC.gitHubResponse);
        else
            updateFailed = await updateMessageStatus(JC);
    }
    if(updateFailed || emailFailed)
        action = action + " FAILED! " + emailFailed + updateFailed;
    return new RollcallResult(JC, action);
}

/**
 * Replace {{ text }} with values from subs in all fields of template
 * @param template {object} series of strings on which to conduct replacement
 * @param subs {object} key-value pairs of handlebar content and the replacement values
 * @return {object} template with substitutions applied
 */
function substituteHandlebars(template, subs) {
    for(let s of Object.keys(template)) {
        if(!template.hasOwnProperty(s) || typeof template[s] !== 'string')
            continue;
        for(let k of Object.keys(subs)) {
            if(subs.hasOwnProperty(k)) {
                template[s] = template[s].replace(
                    new RegExp(`{{ *${k} *}}`),
                    subs[k]
                )
            }
        }
    }
    return template;
}

/**
 * Handle the Mailgun API call
 * @param email {string[]} email to send to
 * @param subject {string} email subject
 * @param body {string} email body (HTML)
 * @return {Error|null}
 */
async function sendEmail(emails, subject, body) {
    // Load mailgun
    const mailgun = require('mailgun-js')({
        apiKey: MAILGUN_API_KEY,
        domain: MAILGUN_DOMAIN,
        host: MAILGUN_HOST
    });

    const mailgunData = {
        from: FROM_EMAIL_ADDRESS,
        to: emails.shift(),
        'h:Reply-To': FROM_EMAIL_ADDRESS,
        subject: subject,
        html: body
    };
    if(emails.length)
        mailgunData.cc = emails.join("; ");

    return mailgun.messages()
        .send(mailgunData, function(error) {
            if(error)
                throw new Error(error);
        })
        .then(() => null)
        .catch(e => `Could not send email: ${e}`);
}

/**
 * Move a journal club file to the _inactive-journal-clubs directory
 * @param jc {object} journal club to move (GitHub response object)
 */
function deactivateJC(jc) {
    // Add the new file
    const content = JSON.stringify({
        message: `Rollcall: Archiving of ${jc.jcid}`,
        content: jc
    });
    fetch(
        `${GITHUB_REPO_API}/${jc.path.replace(/^_/, '_inactive-')}`,
        {
            method: 'PUT',
            headers: {
                'User-Agent': GITHUB_API_USER,
                Authorization: `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': content.length
            },
            body: content
        }
    )
        .then(r => {
            if(r.status !== 200)
                throw new Error(`Could not archive: ${r.statusText} (${r.status})`)
        })
        .then(() => {
            // Remove the old file
            const remove = JSON.stringify({
                message: `Rollcall: Removing ${jc.path}`,
                sha: jc.sha
            });
            fetch(
                jc.url,
                {
                    method: 'DELETE',
                    headers: {
                        'User-Agent': GITHUB_API_USER,
                        Authorization: `token ${GITHUB_TOKEN}`,
                        'Content-Type': 'application/json',
                        'Content-Length': remove.length
                    },
                    body: remove
                }
            );
        })
        .then(r => {
            if(r.status !== 200)
                throw new Error(`Could not remove old file: ${r.statusText} (${r.status})`)
        })
        .catch(e => e);
}

/**
 * Update a journal club to indicate that a new message has been dispatched
 * @param JC {JournalClub}
 * @return {Error|null}
 */
function updateMessageStatus(JC) {
    const body = JC.content;
    let newBody = body.replace(
        /last-message-timestamp: .+$/m,
        `last-message-timestamp: ${Math.floor((new Date()).getTime() / 1000)}`
    );
    newBody = newBody.replace(
        /last-message-level: .+$/m,
        `last-message-level: ${JC.newMessageLevel}`
    );
    // Commit to gitHub with the new body as content
    const newContent = new Buffer.from(newBody).toString('base64');
    const commit = JSON.stringify({
        message: `Rollcall: Update ${JC.jcid}.md last message time.`,
        content: newContent,
        sha: JC.gitHubResponse.sha
    });
    return fetch(
        JC.gitHubResponse.url,
        {
            method: 'PUT',
            headers: {
                'User-Agent': GITHUB_API_USER,
                Authorization: `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': commit.length
            },
            body: commit
        }
    )
        .then(r => {
            if(r.status !== 200) {
                throw new Error(`${r.statusText} (${r.status})`)
            } return null;
        })
        .catch(e => `Could not update last message time: ${e}`);
}

/**
 * Return a list of journal club objects as fetched from the GitHub repository.
 * @return {object[]}
 */
function getOldestJC() {
    return fetch(
        `${GITHUB_REPO_API}/contents/_journal-clubs`,
        {headers: {
            'User-Agent': GITHUB_API_USER,
            Authorization: `token ${GITHUB_TOKEN}`
        }}
    )
        .then(r => r.json())
        .then(async jcs => {
            const jc_details = await Promise.allSettled(jcs.map(jc => {
                let modified = new Date(0);
                return fetch(
                    jc.url,
                    {
                        headers: {
                            'User-Agent': GITHUB_API_USER,
                            Authorization: `token ${GITHUB_TOKEN}`
                        }
                    }
                )
                    .then(r => {
                        modified = new Date(r.headers.get("last-modified"));
                        return r.json();
                    })
                    .then(jc => {
                        jc.modified = modified;
                        return jc;
                    });
            }));
            return jc_details.map(jc => new JournalClub(jc.value));
        })
        // Has the JC been updated recently enough to skip?
        .then(jcs => jcs.filter(jc =>
            jc.lastUpdate < TOO_OLD && jc.lastMessage < TOO_RECENT
        ))
        .then(jcs => {
            if(!jcs.length)
                return null;
            else if(SANDBOX) {
                const ox = jcs.filter(jc => jc.jcid === "oxford");
                if(ox.length)
                    return ox[0];
                return null;
            }

            else
                // Find oldest
                return jcs.reduce((a, b) =>
                    a.gitHubResponse.modified.getTime() <
                    b.gitHubResponse.modified.getTime()?
                        a : b
                )
            }
        );
}
