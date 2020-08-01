const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Sequelize, DataTypes } = require("sequelize");
const Telegram = require("telegraf/telegram");
const axios = require("axios");
const { flag } = require("country-emoji");
const dayjs = require("dayjs");
const relativeTime = require("dayjs/plugin/relativeTime");

dayjs.extend(relativeTime);

/*************************
 * ENVIRONMENT VARIABLES *
 *************************/
const defaultEnvPath = path.join(__dirname, ".env");
const localEnvPath = path.join(__dirname, ".env.local");

const defaultEnv = dotenv.parse(fs.readFileSync(defaultEnvPath));

if (fs.existsSync(localEnvPath)) {
  const localEnv = dotenv.parse(fs.readFileSync(localEnvPath));

  // Overwrite .env.local with .env
  for (let k in localEnv) {
    if (k in defaultEnv && !(k in process.env)) {
      process.env[k] = localEnv[k];
    }
  }
}

dotenv.config({ path: defaultEnvPath });

if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

if (process.env.DATABASE_URL) {
  /**********************
   * HEROKU POSTGRES DB *
   **********************/
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: "postgres",
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false },
    },
    logging: false,
  });
} else {
  /******************
   * DEVELOPMENT DB *
   ******************/
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: "database.sqlite",
    logging: false,
  });
}

/*********
 * MODEL *
 *********/
const Project = sequelize.define("Project", {
  projectId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  notified: { type: DataTypes.BOOLEAN, default: false },
});

/*********
 * START *
 *********/
(async () => {
  // Initialize database
  await sequelize.sync();

  // Initialize bot
  const bot = new Telegram(process.env.BOT_TOKEN);

  // Fetch projects
  while (true) {
    const skills = "3,9,13,30,31,36,51,72,95,116,152,158,199,215,292,301,305,323,335,355,420,454,500,564,598,619,728,741,759,775,901,913,962,1002,1031,1040,1041,1051,1075,1087,1088,1092,1093,1097,1112,1239,1240,1254,1277,1623,1679,1684,1685,1709,1827"
      .split(",")
      .map((i) => `&jobs%5B%5D=${i}`)
      .join("");
    const limit = 300;
    const price = 500;

    const url = `https://www.freelancer.com/api/projects/0.1/projects/active/?compact=true&forceShowLocationDetails=false&full_description=true&job_details=true${skills}&keywords=&languages%5B%5D=en&languages%5B%5D=hi&limit=${limit}&min_avg_price=${price}&offset=0&project_types%5B%5D=fixed&query=&sort_field=submitdate&upgrade_details=true&user_details=true&user_employer_reputation=true&user_status=true`;

    try {
      console.log("Fetching Projects...");
      const response = await axios.get(url);
      const { projects, users } = response.data["result"];

      // good projects
      const goodProjects = projects.filter((p) => {
        const isVerified =
          users[p["owner_id"]]["status"]["deposit_made"] ||
          users[p["owner_id"]]["status"]["payment_verified"];

        const isIndian = p["currency"]["code"] === "INR";
        const isNiched = p["jobs"].length <= process.env.SKILLS_MAX;

        if (isVerified && isNiched && !isIndian) return true;

        return false;
      });

      console.log("Good Projects:", goodProjects.length);

      // sort projects
      goodProjects.sort((a, b) => a["submitdate"] - b["submitdate"]);

      // dispatch messages
      for (let i = 0; i < goodProjects.length; i++) {
        const {
          id,
          owner_id,
          title,
          description,
          currency: { sign, code },
          budget: { minimum, maximum },
          bid_stats: { bid_count, bid_avg },
          seo_url,
          jobs,
          submitdate,
        } = goodProjects[i];
        const projectUrl = `https://freelancer.com/projects/${seo_url}`;
        const projectAgo = dayjs.unix(submitdate).from(dayjs());

        const {
          username,
          registration_date,
          location: { country },
          employer_reputation: { entire_history },
        } = users[owner_id];
        const userUrl = `https://freelancer.com/u/${username}`;
        const userAgo = dayjs.unix(registration_date).from(dayjs());

        // find project
        const [row, created] = await Project.findOrCreate({
          where: { projectId: id },
        });

        if (created || !row.notified) {
          const text = [
            `<b>Title</b>: <a href="${projectUrl}">${title}</a> (${projectAgo})`,
            `<b>Budget</b>: ${sign}${minimum}-${sign}${maximum} (${code})`,
            `<b>Bids</b>: ${bid_count} (Average: ${sign}${bid_avg.toFixed(2)})`,
            `<b>Skills</b>: ${jobs.map((i) => i.name).join(", ")}`,
            `<b>Employer</b>: <a href="${userUrl}">${username}</a> ${flag(
              country.name
            )} (Rating: ${entire_history.overall.toFixed(
              2
            )}, Created: ${userAgo})`,
            `${"-".repeat(50)}\n\n${description}`,
          ]
            .join("\n\n")
            .substr(0, 4096);

          // send message
          await bot
            .sendMessage(process.env.CHAT_ID, text, {
              parse_mode: "html",
              disable_web_page_preview: true,
            })
            .then(async () => {
              // success
              console.log("Notified Project:", id);

              // save project
              return Project.update(
                { notified: true },
                { where: { projectId: id } }
              );
            })
            .catch(console.error);

          // sleep
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.log("Notified Already:", id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
})();
