const appJson = require('./app.json');

const { extra: rootExtra, ...restExpo } = appJson.expo;

module.exports = {
  expo: {
    ...restExpo,
    extra: {
      ...rootExtra,
      eas: {
        ...(rootExtra?.eas || {}),
        projectId: '70a445e0-7223-4600-a8c7-275ceadbc565',
      },
    },
  },
};
