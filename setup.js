const fs = require("fs");

function updateRefreshTokenLocal() {
  try {
    let refres = [];
    const tokens = require("./tokens.json");

    for (const session of Object.values(tokens)) {
      const item = JSON.parse(session);
      if (item?.refreshToken) refres.push(item.refreshToken);
    }
    fs.writeFileSync("data.txt", refres.join("\n"));
  } catch (error) {
    console.error("Error updating refresh tokens:", error);
  }
}

updateRefreshTokenLocal();
