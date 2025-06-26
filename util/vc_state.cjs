const fs = require("fs");
const path = require("path");

const VC_STATE_PATH = path.join(__dirname, "vc_state.json");

function saveVCState(guildId, channelId) {
    let state = {};
    if (fs.existsSync(VC_STATE_PATH)) {
        try {
            state = JSON.parse(fs.readFileSync(VC_STATE_PATH, "utf8"));
        } catch {
            state = {};
        }
    }
    state[guildId] = channelId;
    fs.writeFileSync(VC_STATE_PATH, JSON.stringify(state, null, 2));
}

function clearVCState(guildId) {
    if (!fs.existsSync(VC_STATE_PATH)) return;
    let state = {};
    try {
        state = JSON.parse(fs.readFileSync(VC_STATE_PATH, "utf8"));
    } catch {
        return;
    }
    delete state[guildId];
    fs.writeFileSync(VC_STATE_PATH, JSON.stringify(state, null, 2));
}

module.exports = { saveVCState, clearVCState, VC_STATE_PATH };
