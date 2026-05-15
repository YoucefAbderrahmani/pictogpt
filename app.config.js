const appJson = require('./app.json');

const { extra: rootExtra, ...restExpo } = appJson.expo;

module.exports = {
  expo: {
    ...restExpo,
    extra: {
      ...rootExtra,
      eas: {
        ...(rootExtra?.eas || {}),
        projectId: '301f54bb-df62-4029-b9eb-b5df4304093e',
      },
    },
  },
};
