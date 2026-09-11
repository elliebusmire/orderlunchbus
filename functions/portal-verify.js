const { verify, sessionToken, sessionCookie } = require('./lib/auth');

exports.handler = async (event) => {
  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';
  const link = verify(token, 'link');

  if (!link) {
    return { statusCode: 302, headers: { Location: '/portal.html?link=expired', 'Cache-Control': 'no-store' }, body: '' };
  }

  return {
    statusCode: 302,
    headers: {
      Location: '/portal.html',
      'Set-Cookie': sessionCookie(sessionToken(link.em)),
      'Cache-Control': 'no-store'
    },
    body: ''
  };
};
