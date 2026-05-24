const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");

const cron = require("node-cron");
const { DateTime, FixedOffsetZone } = require("luxon");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let schedules = [];
let nextId = 1;
let serverTimezone = "Europe/London";
const pendingSchedules = new Map();

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

function normalizeTimezone(zone) {
  const value = zone.trim().toLowerCase().replace(/\s/g, "");

  if (value === "london" || value === "uk") return "Europe/London";
  if (value === "turkey" || value === "istanbul") return "Europe/Istanbul";
  if (value === "edt" || value === "est" || value === "et") return "America/New_York";

  const gmtMatch = value.match(/^gmt([+-])(\d{1,2})$/);
  if (gmtMatch) {
    const sign = gmtMatch[1] === "+" ? 1 : -1;
    const hours = Number(gmtMatch[2]);
    if (hours >= 0 && hours <= 12) return `UTC${sign === 1 ? "+" : "-"}${hours}`;
  }

  return zone.trim();
}

function getZone(zone) {
  if (zone.startsWith("UTC+")) return FixedOffsetZone.instance(Number(zone.replace("UTC+", "")) * 60);
  if (zone.startsWith("UTC-")) return FixedOffsetZone.instance(Number(zone.replace("UTC-", "")) * -60);
  return zone;
}

function parseDateTime(date, time) {
  const cleanDate = date.trim();
  const cleanTime = time.trim().replace(/\s/g, "");

  let day, month, year;

  if (cleanDate.includes("-")) {
    [day, month, year] = cleanDate.split("-");
  } else if (cleanDate.includes("/")) {
    const parts = cleanDate.split("/");
    if (parts[0].length === 4) [year, month, day] = parts;
    else [day, month, year] = parts;
  } else {
    return { isValid: false };
  }

  const [hour, minute] = cleanTime.split(":");

  return DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    { zone: getZone(serverTimezone) }
  );
}

function extractChannelIds(rawChannels) {
  if (!rawChannels) return [];

  const ids = [];

  // #channel mention
  const mentionMatches = rawChannels.matchAll(/<#(\d+)>/g);

  for (const match of mentionMatches) {
    ids.push(match[1]);
  }

  // direct IDs
  const idMatches = rawChannels.match(/\b\d{17,20}\b/g);

  if (idMatches) {
    ids.push(...idMatches);
  }

  return [...new Set(ids)];
}

async function sendScheduledMessage(item) {
  for (const channelId of item.channelIds) {
    const channel = await client.channels.fetch(channelId);

    await channel.send({
  content: message,
  files: item.imageUrl ? [item.imageUrl] : [],
  allowedMentions: {
    parse: ["everyone"],
  },
});
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "schedule") {
      const date = interaction.options.getString("date");
      const time = interaction.options.getString("time");
      const rawChannels = interaction.options.getString("channel");
      const image = interaction.options.getAttachment("image");

      const key = `${interaction.user.id}-${Date.now()}`;

      pendingSchedules.set(key, {
        date,
        time,
        rawChannels,
        imageUrl: image ? image.url : null,
        fallbackChannelId: interaction.channelId,
      });

      const modal = new ModalBuilder()
        .setCustomId(`schedule_modal_${key}`)
        .setTitle("Schedule Message");

      const messageInput = new TextInputBuilder()
        .setCustomId("message")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Write your full announcement here...");

      modal.addComponents(new ActionRowBuilder().addComponents(messageInput));

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("schedule_modal_")) {
      await interaction.deferReply({ ephemeral: true });

      const key = interaction.customId.replace("schedule_modal_", "");
      const pending = pendingSchedules.get(key);

      if (!pending) {
        await interaction.editReply({ content: "This schedule form expired. Please run /schedule again." });
        return;
      }

      pendingSchedules.delete(key);

      const message = interaction.fields.getTextInputValue("message");
      const target = parseDateTime(pending.date, pending.time);

      if (!target.isValid) {
        await interaction.editReply({
          content: "Invalid date/time. Use `21-05-2026` and `14:30`.",
        });
        return;
      }

      const channelIdsFromInput = extractChannelIds(pending.rawChannels);
      const channelIds =
        channelIdsFromInput.length > 0 ? channelIdsFromInput : [pending.fallbackChannelId];

      const channelNames = [];

      for (const channelId of channelIds) {
        try {
          const channel = await client.channels.fetch(channelId);
          channelNames.push(channel?.name || channelId);
        } catch {
          channelNames.push(channelId);
        }
      }

      const schedule = {
        id: nextId++,
        channelIds,
        channelNames,
        displayDate: pending.date,
        displayTime: pending.time,
        message,
        imageUrl: pending.imageUrl,
        target,
        sent: false,
      };

      schedules.push(schedule);

      await interaction.editReply({
        content: `Scheduled ID ${schedule.id} for ${pending.date} ${pending.time} (${serverTimezone}) in ${channelNames
          .map((name) => `#${name}`)
          .join(", ")}.`,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "list") {
      await interaction.deferReply({ ephemeral: true });

      const active = schedules.filter((item) => !item.sent);

      await interaction.editReply({
        content:
          active.length === 0
            ? "No active scheduled messages."
            : "Active schedules:\n" +
              active
                .map(
                  (item) =>
                    `ID ${item.id} — ${item.channelNames
                      .map((name) => `#${name}`)
                      .join(", ")} — ${item.displayDate} ${item.displayTime} (${serverTimezone})`
                )
                .join("\n"),
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "cancel") {
      await interaction.deferReply({ ephemeral: true });

      const id = interaction.options.getInteger("id");
      const before = schedules.length;

      schedules = schedules.filter((item) => item.id !== id);

      await interaction.editReply({
        content:
          schedules.length === before
            ? `No schedule found with ID ${id}.`
            : `Cancelled schedule ID ${id}.`,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "timezone") {
      await interaction.deferReply({ ephemeral: true });

      const zone = normalizeTimezone(interaction.options.getString("zone"));
      const test = DateTime.now().setZone(getZone(zone));

      if (!test.isValid) {
        await interaction.editReply({
          content: "Invalid timezone. Use `Europe/London`, `GMT+1`, `GMT+3`, `EDT`, etc.",
        });
        return;
      }

      serverTimezone = zone;

      await interaction.editReply({
        content: `Timezone set to ${serverTimezone}.`,
      });
      return;
    }
  } catch (error) {
    console.error(error);
  }
});

cron.schedule("* * * * *", async () => {
  const now = DateTime.now().setZone(getZone(serverTimezone));

  for (const item of schedules) {
    if (item.sent) continue;

    const minutesUntil = item.target.diff(now, "minutes").minutes;

    if (minutesUntil <= 0 && minutesUntil > -5) {
      await sendScheduledMessage(item);
      item.sent = true;
    }
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Schedule a message")
    .addStringOption((option) =>
      option.setName("date").setDescription("DD-MM-YYYY or YYYY/MM/DD").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("time").setDescription("HH:mm").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel")
        .setDescription("Optional. Mention one or more channels, e.g. #chat #wins")
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Optional image attachment").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("List active scheduled messages"),

  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel a scheduled message")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Schedule ID").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Set timezone")
    .addStringOption((option) =>
      option.setName("zone").setDescription("Europe/London, GMT+1, GMT+3, EDT").setRequired(true)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Commands registered");
  } catch (error) {
    console.error(error);
  }
})();

client.login(process.env.DISCORD_TOKEN);
