var GithubGraphQLApi = require('node-github-graphql')

// To update or delete rows from Azure Table Storage:
// https://anthonychu.ca/post/azure-functions-update-delete-table-storage/

const github_token = process.env.GITHUB_API_TOKEN;
const gh_api = new GithubGraphQLApi({
  token: process.env.GITHUB_API_TOKEN
})
const prs_fetched_per_call = 100;

const usernames = [
  'langdalp',
  'mikaelbr',
  'christianalfoni',
  'torgeir',
  'dagstuan',
  'mahic'
]

function pr_query(username, afterCursor = null) {
  let paginationString = `first: ${prs_fetched_per_call}`;
  if (afterCursor) {
    paginationString = `first: ${prs_fetched_per_call} after: "${afterCursor}"`;
  }
  return `
  {
    user(login: "${username}") { 
      pullRequests(${paginationString}) {
        totalCount
        edges {
          node {
            id
            resourcePath
            title
            createdAt
          }
          cursor
        }
      }
    }
  }`;
}

// Dates are stored as 'Date=2014-03-11T14:38:32Z' because Table Storage parses and mangles dates otherwise
// More details: When you retrieve pull reqs. from Table Storage, the date format is like this: '21/03/2014 18:41:47'
function prWithParsedDate(pr) {
  const copy = Object.assign({}, pr);
  const dateString = copy.createdAt.split('=')[1];
  copy.createdAt = new Date(dateString);
  return copy;
}

function sortPrsMostRecentFirst(a, b) {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt >= b.createdAt ? -1 : 1;
}

function fetchStoredPrsForUser(context, username) {
  const tableRows = context.bindings.tableReadBinding;
  const pullReqsForUser = tableRows
    .filter(pr => pr.PartitionKey === username)
    .map(prWithParsedDate);
  pullReqsForUser.sort(sortPrsMostRecentFirst);
  return pullReqsForUser;
}

function pushSinglePullRequest(tableWriteBinding, username, pullRequestNode, cursor) {
  tableWriteBinding.push({
    PartitionKey: username,
    RowKey: pullRequestNode.id,
    title: pullRequestNode.title,
    resourcePath: pullRequestNode.resourcePath,
    createdAt: `Date=${pullRequestNode.createdAt}`, /* Table Storage parses and mangles date otherwise */
    cursor: cursor
  });
}

function fetchAndStorePullRequestsFromGitHub(context, username, lastCursor = null) {
  gh_api.query(pr_query(username, lastCursor), null, (res, err) => {
    if (err)  return context.done(err, null);
    let prData = res.data.user.pullRequests;
    let numPrsTotal = prData.totalCount;
    let numPrsFetched = prData.edges.length;
    let fetchedPrsWithCursors = prData.edges;

    context.bindings.tableWriteBinding = []
    fetchedPrsWithCursors.forEach(
      element => pushSinglePullRequest(
        context.bindings.tableWriteBinding, username, element.node, element.cursor));

    context.done(err, {
      body: fetchedPrsWithCursors,
      headers: {
        'Content-Type': 'application/json'
      }
    })
  });
}

function fetchAndStorePullRequestsFromGitHubNew(tableWriteBinding, username, lastCursor = null) {
  var queryPromise = gh_api.query(pr_query(username, lastCursor), null);
  return (queryPromise
    .catch((err) => { console.log(err) })
    .then(res => {
      let prData = res.data.user.pullRequests;
      let numPrsTotal = prData.totalCount;
      let numPrsFetched = prData.edges.length;
      let fetchedPrsWithCursors = prData.edges;
      console.log(`Found ${numPrsFetched} previously unseen pull reqs for user ${username}`);

      fetchedPrsWithCursors.forEach(
        element => pushSinglePullRequest(tableWriteBinding, username, element.node, element.cursor));
      return fetchedPrsWithCursors;
    }));
}

// TODO: Change timerTrigger to every hour?
module.exports = function (context, timerTrigger) {
  let promises = [];
  context.bindings.tableWriteBinding = [];
  for (let username of usernames) {
    console.log(`Looking for new PRs for ${username}...`);
    let storedPullReqs = fetchStoredPrsForUser(context, username);
    const lastPullReq = storedPullReqs.length ? storedPullReqs[0] : null;
    const lastCursor = lastPullReq ? lastPullReq.cursor : null;
    promises.push(fetchAndStorePullRequestsFromGitHubNew(context.bindings.tableWriteBinding, username, lastCursor));
  }
  Promise.all(promises)
    .then(() => { context.done() });
};