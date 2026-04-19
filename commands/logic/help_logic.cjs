const {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");
const { logErrorToChannel } = require("./helpers.cjs");

const helpTopics = {
  usage: `## **VC Tools ◈ Help ◈ Usage**
- Use VC Tools via \`>\`, \`!\`, and slash commands.
- Access the user guide by clicking [here](<https://www.vctools.app/user-guide>).
- Review the privacy policy by clicking [here](<https://www.vctools.app/privacy>).
> **Subcommands:**
- help usage
- help initialize
- help commands
- help errors
- help error <code>
- help tc
- help notify
- help settings
- help safeuser
- help safechannel
- help rms
- help filter
- help report
- help vc`,

  initialize: `## **VC Tools ◈ Help ◈ Initialize**
> \`initialize\` ◈ Start the setup process for VC Tools.

> **Initialization Methods:**
- \`ftt\` (from the top) ◈ Full setup process, including transcription, error logs, and staffroles.
- \`transcription\` ◈ Sets up voice transcription without error logging or staff roles.
- \`errorlogs\` ◈ Only sets up error logging without transcription or staff roles.
- \`staffroles\` ◈ Only sets up staff roles for managing the bot without transcription or error logging.

> **Setup Notes:**
- \`ftt\` ensures everything is configured at once.
- You can configure settings later using \`settings transcription\`, \`settings errorlogs\`, \`settings bot\`, or \`settings vc\`.
- Re-running the same initialization method will not reset previous settings.`,

  commands: `## **VC Tools ◈ Help ◈ Commands**
- \`settings\` - Open the settings menu.
- \`initialize\` - Show initialization topics.
- \`safeuser\` - Manage users that should not be transcribed.
- \`safechannel\` - Manage voice channels that should not be transcribed.
- \`rms\` - View RMS detection settings and thresholds.
- \`filter\` - Manage the profanity filter settings.
- \`report\` - Submit a report about an issue or voice call activity.
- \`vc\` - Manage voice channel permissions (kick, mute, unmute).
- \`tc\` - Moderator text channel commands for managing users in text channels (mute, unmute, kick, ban).
- \`disallow\` - Remove your data from the VC Tools database.
- \`drain\` - Disconnect users from a voice channel.
> \`help\` - Show help topics on each of the commands above. Use \`help <command>\` to get specific help on a command.`,

  errors: `## **VC Tools ◈ Help ◈ Errors**
> **Error Codes:**
- CMD_ERR_001 - Triggered when an unknown subcommand is passed.
- INIT_ERR_002 - Occurs during initialization due to missing/incomplete guild data.
- INT_ERR_003 - Occurs when the interaction context for a user is missing or expired.
- INT_ERR_004 - Occurs when a user interacts with a component not assigned to them.
- INT_ERR_005 - Occurs when the bot encounters an unexpected interaction mode.
- INT_ERR_006 - Occurs when the bot encounters an unexpected issue processing an interaction.
- HELP_ERR_007 - Occurs when a user requests an unknown help subcommand.
- CMD_ERR_008 - Occurs when a user executes a command without sufficient permissions.
- REP_ERR_009 - Occurs when a user report cannot be forwarded to the developers.
- VC_ERR_010 - Occurs when a voice command fails for an unknown reason.
- REP_ERR_011 - Occurs when a user tries to use \`report activity\` and the bot cannot find the transcription channel ID.
> For more details, use \`help error <error_code>\`.`,

  notify: `## **VC Tools ◈ Help ◈ Notify**
The notification system lets users add others to their notification list. When users on their notification list join a voice channel in a mutual server, they will be notified.
Of course, there are also privacy settings to control who can see your activity and who can add you to their notification list.
> **Notify Commands:**
- \`notify add\` - Add a user to your notification list.
- \`notify remove\` - Remove a user from your notification list.
- \`notify clear\` - Clear all users from your notification list.
- \`notify list\` - List all users you are currently notified about.
- \`notify status\` - Change your activity visibility for all users at once.
-# > \`open\` - users can add you to their notification list, and everyone who has added you to their notification list can see your activity, except for the people that you have blocked.
-# > \`invisible\` - everyone can add you to their notification list, but nobody can see your activity.
-# > \`closed\` - users cannot add you to their notification list, and nobody can see your activity.
- \`notify block\` - Silently stop someone from being notified about your activities.
- \`notify unblock\` - Allow someone to be notified about your activities again.
- \`notify blocks\` - List all users you have blocked from receiving notifications about you.
> **Usage Examples:**
- \`notify add <user>\`
- \`notify remove <user>\`
- \`notify clear\`
- \`notify list\`
- \`notify status <open|invisible|closed>\`
- \`notify block <user>\`
- \`notify unblock <user>\`
- \`notify blocks\``,

  settings: `## **VC Tools ◈ Help ◈ Settings**
> **Settings Commands:**
- \`settings transcription\` - View and modify transcription settings.
- \`settings errorlogs\` - Configure error logging settings.
- \`settings bot\` - View and modify bot settings, including admin and moderator roles.
- \`settings vc\` - View and modify voice channel settings, including VC event logging.
- \`settings prefix\` - Configure command prefixes for the bot.
- \`settings consent\` - Manage where the consent message is delivered.`,

  safeuser: `## **VC Tools ◈ Help ◈ Safeuser**
> **Safeuser Commands:**
- \`safeuser set <userId>\` - Mark a user as safe so that their voice will not be transcribed.
- \`safeuser remove <userId>\` - Remove a user from the safe list.
- \`safeuser list\` - List all users currently marked as safe inside this server.
> **Usage Examples:**
- \`safeuser set <@userid>\`
- \`safeuser remove <@userid>\`
- \`safeuser list\``,

  safechannel: `## **VC Tools ◈ Help ◈ Safechannel**
> **Safechannel Commands:**
- \`safechannel set <channelId>\` - Mark a voice channel as safe so that voices will not be transcribed.
- \`safechannel remove <channelId>\` - Remove a channel from the safe list.
- \`safechannel list\` - List all channels currently marked as safe inside this server.
> **Usage Examples:**
- \`safechannel set <channel id>\`
- \`safechannel remove <channel id>\`
- \`safechannel list\``,

  rms: `## **VC Tools ◈ Help ◈ RMS**
> **RMS Detection Overview:**
- **RMS (Root Mean Square)** is a measure of the average power (or loudness) of an audio signal.
- VC Tools calculates the RMS of a user's microphone to determine if their volume exceeds set thresholds.
> (Discord Calibrated) **Threshold table**
- **0-10000:** Moderate (anything from a whisper to a loud conversation) \`✅ Will not trigger a warning\`
- **10000-14000:** Loud (shouting, loud music) \`⚠️ Likely to trigger a prolonged warning\`
- **14000-17500:** Very loud (screaming, very loud music) \`⚠️ Likely to trigger fast or instant warnings\`
- **17500+:** Extremely loud (distorted sounds, very close microphone) \`💥 Will trigger an instant warning\`
> If a user's microphone exceeds these limits, moderators are notified.`,

  filter: `## **VC Tools ◈ Help ◈ Filter**
> **Filter Management Overview:**
- Use \`settings filter\` to manage the profanity filter.
- **Filter Level:** Choose between \`off\`, \`build\`, \`moderate\`, and \`strict\`.
  - **Strict:** Aggressive filtering.
  - **Moderate:** Lenient filtering.
  - **Build:** Empty custom filter.
  - **Off:** No filtering is applied.
> **Subcommands:**
- \`filter add <word>\`
- \`filter remove <word>\`
- \`filter list\`
- \`filter level <build|moderate|strict>\``,

  report: `## **VC Tools ◈ Help ◈ Report**
> **Report Commands:**
- \`report issue\` - Submit a new report to the developers about an issue you're experiencing with VC Tools.
- \`report activity\` - Submit a report about a specific voice call activity.
-# > \`report activity\` requires transcription to be enabled.
- \`report view <id>\`
- \`report close <id>\`
- \`report edit <id> <description|details> <new value>\`
> **Usage Examples:**
- \`report view 123ABC\`
- \`report close 123ABC\`
- \`report edit 123ABC details Issue still happening, but with more details.\``,

  drain: `## **VC Tools ◈ Help ◈ Drain**
> **Drain Commands:**
- \`drain <voice channel>\` — Disconnects all users from the specified voice channel.
- Works through both slash commands and message commands.
- You must have **Manage Server** permissions to use this command.

> **Usage Examples:**
- \`drain <channel>\`
- \`/drain channel: <channel>\`
> **Notes:**
- VC Tools will log drained channels into the configured activity log channel, if set.
- VC Tools will not disconnect itself, but will disconnect other bots.`,

  vc: `## **VC Tools ◈ Help ◈ VC Commands**
> **Voice Channel Commands:**
- \`vc kick <user>\`
- \`vc mute <user>\`
- \`vc unmute <user>\``,

  tc: `## **VC Tools ◈ Help ◈ Text Channel Commands**
> **Text Channel Commands:**
- \`tc mute <user> <duration> <reason>\` — Timeout a user.
- \`tc unmute <user>\`
- \`tc kick <user> <reason>\`
- \`tc ban <user> <reason>\``,

  default: `## **VC Tools ◈ Help**
> **Usage:**
- Use VC Tools via \`>\`, \`!\`, and slash commands.
- Access the user guide by clicking [here](<https://www.vctools.app/user-guide>).
- Review the privacy policy by clicking [here](<https://www.vctools.app/privacy>).
> **Subcommands:**
- help usage
- help initialize
- help commands
- help errors
- help error <code>
- help tc
- help notify
- help settings
- help safeuser
- help safechannel
- help rms
- help filter
- help report
- help vc`,
};

const errorHelpMessages = {
  CMD_ERR_001: `Triggered when an unknown subcommand is passed.
-# **For staff:** Check your server's error logs. If you believe that this subcommand is supposed to exist, then use \`report issue\` to report it.`,

  INIT_ERR_002: `Occurs during initialization due to missing or incomplete guild data.
-# **For staff:** Check error logs and use \`report issue\` if needed.`,

  INT_ERR_003: `Occurs when the interaction context for a user is missing or expired.
-# **For staff:** This may occur after a system crash or reboot. Try re-running the command or interaction. If the issue persists, then use \`report issue\`.`,

  INT_ERR_004: `Occurs when a user interacts with a component not assigned to them.
-# **For staff:** Verify that the user interacting with the component is the same user who executed the command. If the issue persists, then use \`report issue\`.`,

  INT_ERR_005: `Occurs when the bot encounters an unexpected interaction mode.
-# **For staff:** Check error logs for further details. If the issue persists, then use \`report issue\`.`,

  INT_ERR_006: `Occurs when the bot encounters an unexpected issue processing an interaction.
-# **For staff:** Check error logs for further details. If the issue persists, then use \`report issue\`.`,

  HELP_ERR_007: `Occurs when a user requests an unknown help subcommand.
-# **For staff:** Check your server's error logs. If you believe that this subcommand is supposed to exist, then use \`report issue\`.`,

  CMD_ERR_008: `Occurs when a user executes a command or interacts with a component without sufficient permissions.
-# **For staff:** Verify user permissions and check error logs.`,

  REP_ERR_009: `Occurs when a user report cannot be forwarded to the developers.
-# **For staff:** Check error logs and try to use \`report issue\` yourself. If this doesn't work, then report it on the GitHub repository or contact Acrellux over Discord.`,

  VC_ERR_010: `Occurs when a voice command fails for an unknown reason.
-# **For staff:** Check error logs and use \`report issue\` if needed.`,

  REP_ERR_011: `Occurs when a user tries to use the \`activity report\` command and the bot cannot find the channel ID for transcription.
-# **For staff:** Use \`initialize transcription\` if you haven't initialized the bot. If you have already initialized the bot, then verify that the channel ID for transcription is set in the bot settings.
-# You do not need to enable transcription to do either of these.`,
};

function paginate(text, maxLength = 1800) {
  const pages = [];
  let currentPage = "";
  const lines = text.split("\n");

  for (const line of lines) {
    const next = currentPage ? `${currentPage}\n${line}` : line;
    if (next.length > maxLength) {
      if (currentPage) pages.push(currentPage);
      currentPage = line;
    } else {
      currentPage = next;
    }
  }

  if (currentPage) pages.push(currentPage);
  return pages.length ? pages : ["No help content available."];
}

function getErrorPages() {
  return Object.entries(errorHelpMessages).map(([code, desc]) => {
    return [
      `## **VC Tools ◈ Help ◈ Error ${code}**`,
      `\`${code}\` - ${desc.trim()}`,
      ``,
      `Use \`help error ${code}\` to view this again.`,
    ].join("\n");
  });
}

function buildHelpEmbed(pages, currentPage) {
  return new EmbedBuilder()
    .setTitle("VC Tools ◈ Help")
    .setDescription(pages[currentPage])
    .setFooter({ text: `Page ${currentPage + 1} of ${pages.length}` });
}

function buildButtons(page, pages, userId, topic) {
  const firstBtn = new ButtonBuilder()
    .setCustomId(`help:${topic}:first:${page}:${userId}`)
    .setLabel("⇤")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === 0);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`help:${topic}:prev:${page}:${userId}`)
    .setLabel("◄")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`help:${topic}:next:${page}:${userId}`)
    .setLabel("►")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === pages.length - 1);

  const lastBtn = new ButtonBuilder()
    .setCustomId(`help:${topic}:last:${page}:${userId}`)
    .setLabel("⇥")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === pages.length - 1);

  return [new ActionRowBuilder().addComponents(firstBtn, prevBtn, nextBtn, lastBtn)];
}

function disableButtons(componentRows) {
  return componentRows
    .map((row) => {
      const disabledRow = new ActionRowBuilder();

      for (const component of row.components) {
        try {
          disabledRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
        } catch (err) {
          console.warn("[WARN] Failed to disable help button:", err.message);
        }
      }

      return disabledRow;
    })
    .filter((row) => row.components.length > 0);
}

function resolveHelpTopic(raw) {
  const topic = String(raw || "").trim().toLowerCase();
  if (!topic) return { kind: "topic", value: "default" };
  if (topic === "error") return { kind: "invalid_topic", value: topic };
  if (topic.startsWith("error ")) {
    const code = topic.slice("error ".length).trim().toUpperCase();
    return { kind: "error_code", value: code };
  }
  if (topic in helpTopics) return { kind: "topic", value: topic };
  return { kind: "invalid_topic", value: topic };
}

async function sendUnknownHelpTopic(target, topic, ephemeral = false) {
  const content =
    `> <❌> Unknown help topic \`${topic}\`. (HELP_ERR_007)\n` +
    `Use \`help\` to see the available help topics.`;

  if (target instanceof Message) {
    return target.channel.send({ content });
  }

  if (target.replied || target.deferred) {
    return target.followUp({ content, ephemeral });
  }

  return target.reply({ content, ephemeral });
}

async function sendSpecificErrorHelp(target, code, ephemeral = false) {
  if (!errorHelpMessages[code]) {
    const content =
      `> <❌> Unknown error code \`${code}\`. (HELP_ERR_007)\n` +
      `Use \`help errors\` to see a list of valid codes.`;

    if (target instanceof Message) {
      return target.channel.send({ content });
    }

    if (target.replied || target.deferred) {
      return target.followUp({ content, ephemeral });
    }

    return target.reply({ content, ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle(`VC Tools ◈ Help ◈ Error ${code}`)
    .setDescription(`\`${code}\` - ${errorHelpMessages[code]}`)
    .setColor("Red");

  if (target instanceof Message) {
    return target.channel.send({ embeds: [embed] });
  }

  if (target.replied || target.deferred) {
    return target.followUp({ embeds: [embed], ephemeral });
  }

  return target.reply({ embeds: [embed], ephemeral });
}

async function showHelpContent(interactionOrMessage, subCommandName, ephemeral = false) {
  const resolved = resolveHelpTopic(subCommandName);

  if (resolved.kind === "error_code") {
    return sendSpecificErrorHelp(interactionOrMessage, resolved.value, ephemeral);
  }

  if (resolved.kind === "invalid_topic") {
    return sendUnknownHelpTopic(interactionOrMessage, resolved.value, ephemeral);
  }

  const topic = resolved.value;
  const pages =
    topic === "errors"
      ? getErrorPages()
      : paginate(helpTopics[topic] || helpTopics.default, 1800);

  const userId = interactionOrMessage.user
    ? interactionOrMessage.user.id
    : interactionOrMessage.author.id;

  let currentPage = 0;
  const embed = buildHelpEmbed(pages, currentPage);
  const components = pages.length > 1 ? buildButtons(currentPage, pages, userId, topic) : [];

  let helpMsg;

  if (interactionOrMessage instanceof Message) {
    helpMsg = await interactionOrMessage.channel.send({
      embeds: [embed],
      components,
      fetchReply: true,
    });
  } else {
    const responder =
      interactionOrMessage.replied || interactionOrMessage.deferred
        ? interactionOrMessage.followUp
        : interactionOrMessage.reply;

    helpMsg = await responder.call(interactionOrMessage, {
      embeds: [embed],
      components,
      ephemeral,
      fetchReply: true,
    });
  }

  if (pages.length <= 1) return;

  const collector = helpMsg.createMessageComponentCollector({
    filter: async (i) => {
      if (!i.customId.startsWith("help:")) return false;

      const parts = i.customId.split(":");
      const expectedUserId = parts[4];

      if (i.user.id !== expectedUserId) {
        await i.reply({
          content: "> <❇️> You cannot interact with this help menu. (INT_ERR_004)",
          ephemeral: true,
        }).catch(() => { });
        return false;
      }

      return true;
    },
    time: 3 * 60 * 1000,
  });

  collector.on("collect", async (i) => {
    try {
      let [, btnTopic, action, pageStr, btnUserId] = i.customId.split(":");
      let pageIndex = Number(pageStr) || 0;

      const currentPages =
        btnTopic === "errors"
          ? getErrorPages()
          : paginate(helpTopics[btnTopic] || helpTopics.default, 1800);

      switch (action) {
        case "first":
          pageIndex = 0;
          break;
        case "prev":
          pageIndex = Math.max(pageIndex - 1, 0);
          break;
        case "next":
          pageIndex = Math.min(pageIndex + 1, currentPages.length - 1);
          break;
        case "last":
          pageIndex = currentPages.length - 1;
          break;
        default:
          pageIndex = Math.min(Math.max(pageIndex, 0), currentPages.length - 1);
          break;
      }

      await i.update({
        embeds: [buildHelpEmbed(currentPages, pageIndex)],
        components: buildButtons(pageIndex, currentPages, btnUserId, btnTopic),
      });
    } catch (err) {
      console.error("[ERROR] Failed to update help page:", err);

      if (!i.replied && !i.deferred) {
        await i.reply({
          content: "> <❌> Something went wrong updating the help message. (INT_ERR_006)",
          ephemeral: true,
        }).catch(() => { });
      }
    }
  });

  collector.on("end", async () => {
    try {
      await helpMsg.edit({
        components: disableButtons(helpMsg.components),
      }).catch(() => { });
    } catch (err) {
      console.error("[ERROR] Failed to disable help buttons:", err);
    }
  });
}

async function handleHelpMessageCommand(message, args) {
  try {
    const subCommandName = args.join(" ").trim();
    await showHelpContent(message, subCommandName, false);
  } catch (error) {
    console.error(`[ERROR] handleHelpMessageCommand failed: ${error.message}`);
    await logErrorToChannel(
      message.guild?.id,
      error.stack || String(error),
      message.client,
      "handleHelpMessageCommand"
    );

    await message.channel.send(
      "> <❌> An error occurred while processing the help command. (INT_ERR_006)"
    ).catch(() => { });
  }
}

async function handleHelpSlashCommand(interaction) {
  try {
    const subCommandName = interaction.options.getSubcommand(false) || "";
    const errorCode = interaction.options.getString("code", false);

    const combined =
      subCommandName === "error" && errorCode
        ? `error ${errorCode}`
        : subCommandName;

    await showHelpContent(interaction, combined, true);
  } catch (error) {
    console.error(`[ERROR] handleHelpSlashCommand failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack || String(error),
      interaction.client,
      "handleHelpSlashCommand"
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "> <❌> An error occurred processing the help command. (INT_ERR_006)",
        ephemeral: true,
      }).catch(() => { });
    }
  }
}

module.exports = {
  handleHelpMessageCommand,
  handleHelpSlashCommand,
  showHelpContent,
};