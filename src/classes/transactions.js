const schedule = require('node-schedule');
const bch = require('bitcore-lib-cash');
const bchRPC = require('bitcoin-cash-rpc');
const base58check = require('base58check');
const cashaddr = require('cashaddrjs');
const bchaddr = require('bchaddrjs');
const bcash = require('./bcash').default;
const config = require('../../knexfile.js');
const knex = require('knex')(config);
const cost = 800000;

const env = process.env.NODE_ENV || 'development';

let host =
  env == 'production'
    ? process.env.RAZZLE_PROD_NODE_HOST
    : process.env.RAZZLE_NODE_HOST;

const bchNode = new bchRPC(
  host,
  process.env.RAZZLE_NODE_USERNAME,
  process.env.RAZZLE_NODE_PASSWORD,
  process.env.RAZZLE_NODE_PORT,
  3000
);
const genesisBlock = 563720;

class Transactions {
  async run() {
    schedule.scheduleJob('0-59/15 * * * * *', () => {
      this.registerJobs();
      //console.log('ran registerJobs on  ', Date());
    });
  }
  async calculateDiff(current) {
    let currentHeight = await bchNode.getBlockCount();

    let diff = current - genesisBlock + 101;
    return diff;
  }
  async antiCheat(body) {
    let { uniqid, txid } = body;
    if (txid === undefined) {
      return { success: false, status: `missing txid` };
    }
    if (uniqid === undefined) {
      return { success: false, status: `missing uniqid` };
    }
    let exists = await this.checkExistingTx(txid);
    if (exists.length) {
      return {
        success: false,
        status: `transaction paid for a registration already`
      };
    }
    return { success: true };
  }
  async createCashAccount(body) {
    const { address, username } = body;
    let txString = await this.generateTxString(address, username);
    let hex = await bchNode.signRawTransaction(txString);
    let txid = await bchNode.sendRawTransaction(hex.hex);
    return txid;
  }
  async generateTxString(addr, username) {
    let paymentData = this.id_payment_data(addr);
    let payload = {
      alias: username,
      payment_data: paymentData
    };
    let script = this.build_script(payload);

    const unspent = await bchNode.listUnspent(0);
    if (unspent.length === 0) {
      return { status: 'no UTXOs available' };
    }
    const changeAddr = await bchNode.getRawChangeAddress();

    let tx = new bch.Transaction().from(unspent[0]).feePerKb(1002);
    tx.addOutput(new bch.Transaction.Output({ script: script, satoshis: 0 }));
    tx.change(changeAddr);

    return tx.toString();
  }
  validateBchAddress(address) {}

  async validateBody(body) {
    let { address, blockheight, number, username, minNumber } = body;
    number = parseInt(number);

    let currentHeight = await bchNode.getBlockCount();
    let diff = currentHeight - genesisBlock + 101;

    if (address === undefined || address === '') {
      return { success: false, status: `missing address` };
    }
    if (username === undefined) {
      return { success: false, status: `missing username` };
    }

    if (blockheight < currentHeight) {
      return { success: false, status: `blockheight for #${diff} expired` };
    }

    if (number < minNumber) {
      return { success: false, status: `that block has been mined already` };
    }

    return { success: true };
  }

  async checkJob(body) {
    const maxLimit = 23;
    let status = await this.validateBody(body);
    if (!status.success) {
      return status;
    }
    const count = await knex('Jobs')
      .where({
        blockheight: body.blockheight
      })
      .then(x => {
        return x.length;
      });
    if (count >= maxLimit) {
      return {
        success: false,
        status: `too many queued jobs for #${body.number}`
      };
    } else {
      return { success: true };
    }
  }

  async checkExistingTx(txid) {
    return knex('Jobs').where({ paidwithtxid: txid });
  }

  async getJobs() {
    const currentHeight = await bchNode.getBlockCount();
    return knex('Jobs')
      .select('number', 'username', 'blockheight')
      .where('blockheight', '>', currentHeight)
      .orderBy('blockheight', 'asc')
      .limit(125)
      .catch(er => {
        console.log('error getJobs', er);
      });
  }

  async getUncompletedJobs() {
    const currentHeight = await bchNode.getBlockCount();
    return knex('Jobs')
      .where('blockheight', '>', currentHeight)
      .where({ completed: false })
      .orderBy('blockheight', 'asc')
      .limit(250)
      .catch(er => {
        console.log('error getUncompletedJobs', er);
      });
  }

  async getRegistered() {
    const currentHeight = await bchNode.getBlockCount();
    return knex('Jobs')
      .select('username', 'number', 'registrationtxid', 'completed', 'address')
      .where('blockheight', '<=', currentHeight)
      .where({ completed: true })
      .orderBy('blockheight', 'desc')
      .limit(25)
      .catch(er => {
        console.log('error getUncompletedJobs', er);
      });
  }
  async registerJobs() {
    const currentHeight = await bchNode.getBlockCount();
    const jobs = await this.getUncompletedJobs();

    jobs.map(async x => {
      if (x.blockheight == currentHeight + 1) {
        //console.log('registering', x);
        if (x.paidwithtxid !== undefined || x.paidwithtxid !== null) {
          let txid = await this.createCashAccount(x);
          console.log('registered', `${x.username}#${x.number}`, txid);
          this.markCompleted(x.id, txid, x.blockheight);
        }
      }
    });

    // for (const each of jobs) {

    //   if (each.blockheight == currentHeight + 1) {
    //     //console.log('registering', each);
    //     if (each.paidwithtxid !== undefined || each.paidwithtxid !== null) {
    //       let txid = await this.createCashAccount(each);
    //       console.log('registered', `${each.username}#${each.number}`, txid);
    //       this.markCompleted(each.id, txid, each.blockheight);
    //     }
    //   }
    // }
    return;
  }

  async markCompleted(id, txid, blockheight) {
    blockheight = blockheight - 1;
    const blockHash = await bchNode.getBlockHash(blockheight);

    return knex('Jobs')
      .where({ id: id })
      .update({ registrationtxid: txid, completed: true, blockhash: blockHash })
      .catch(er => {
        console.log('error markCompleted', er);
      });
  }

  build_script(alias) {
    let data_map = {
      p2pkh: '01',
      p2sh: '02',
      p2pc: '03',
      p2sk: '04'
    };

    const s = new bch.Script();
    s.add(bch.Opcode.OP_RETURN);
    s.add(Buffer.from('01010101', 'hex'));
    s.add(Buffer.from(alias.alias, 'utf8'));

    for (let [key, value] of Object.entries(alias.payment_data)) {
      s.add(Buffer.from(data_map[key] + value, 'hex'));
    }
    return s;
  }

  s2h(script) {
    let parts = script
      .toString()
      .replace('OP_RETURN', '0x6a')
      .split(' ');
    let string = '';
    for (let p of parts) {
      if (p.indexOf('0x') === 0) {
        string += p.substring(2);
      } else {
        let hc = p.toString(16);
        if (hc.length % 2) hc = '0' + hc;
        string += hc;
      }
    }

    return string;
  }

  id_payment_data(pd) {
    if (typeof pd === 'string') pd = [pd];
    const id = {};

    for (let item of pd) {
      try {
        //p2pkh/p2sh
        const type = bchaddr.detectAddressType(item);
        id[type] = Buffer.from(
          cashaddr.decode(bchaddr.toCashAddress(item)).hash
        ).toString('hex');
        continue;
      } catch (err) {}

      try {
        //bip47 payment code
        const b58 = base58check.decode(item);
        if (b58.prefix.toString('hex') === '47' && b58.data.length == 80) {
          id['p2pc'] = b58.data.toString('hex');
          continue;
        }
      } catch (err) {}

      // failed to detect an address
      return false;
    }

    return id;
  }
}

let contain = new Transactions();
export default contain;
