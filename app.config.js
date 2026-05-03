const appJson = require('./app.json');

const { extra: rootExtra, ...restExpo } = appJson.expo;

module.exports = {
  expo: {
    ...restExpo,
    extra: {
      ...rootExtra,
    },
  },
};
