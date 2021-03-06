"use strict";
const _ = require('lodash');
const Big = require('big.js');
const Errors = require('../../errors');
const serviceRegistry = require('../../service-registry');
const PromiseHelper = require('../../promise-helper');
const FakeExchangeClass = require('../../fake-exchange');

module.exports = function(app, bodyParsers, config) {

let exchanges = {};
_.forEach(serviceRegistry.getExchanges(), (obj, id) => {
    if (obj.features.balances.enabled)
    {
        // use fakeExchange if demo mode is enabled for exchange
        if (obj.demo)
        {
            exchanges[id] = {isDemo:true, instance:new FakeExchangeClass(obj.instance)};
        }
        else
        {
            exchanges[id] = {isDemo:false, instance:obj.instance};
        }
    }
});
let coinmarketcap = serviceRegistry.getService('coinmarketcap');
if (null !== coinmarketcap)
{
    coinmarketcap = coinmarketcap.instance;
}

//-- only enable route if we have exchanges with supported feature AND coinmarketcap
if (null === coinmarketcap || _.isEmpty(exchanges))
{
    return;
}


const logError = (e, method) => {
    Errors.logError(e, `portfolio|${method}`)
}

/**
 * @param {string} exchanges list of exchanges to include in the result (optional, all by default)
 * @param {string[]} convertTo used to convert result to some others symbols/currencies (optional)
 */
app.get('/portfolio', (req, res) => {
    let filteredList = [];
    if (undefined !== req.query.exchanges && '' != req.query.exchanges)
    {
        // support both array and comma-separated string
        if (Array.isArray(req.query.exchanges))
        {
            _.forEach(req.query.exchanges, (id) => {
                if (undefined !== exchanges[id])
                {
                    filteredList.push(id);
                }
            });
        }
        else
        {
            let arr = req.query.exchanges.split(',');
            _.forEach(arr, (id) => {
                if (undefined !== exchanges[id])
                {
                    filteredList.push(id);
                }
            });
        }
        if (0 == filteredList.length)
        {
            return res.send({balances:{},price:0,convertedPrice:{}});
        }
    }
    else
    {
        // by default query all supported exchanges
        filteredList = Object.keys(exchanges);
    }
    let convertTo = [];
    if (undefined !== req.query.convertTo && '' != req.query.convertTo)
    {
        // support both array and comma-separated string
        if (Array.isArray(req.query.convertTo))
        {
            _.forEach(req.query.convertTo, (c) => {
                convertTo.push(c);
            });
        }
        else
        {
            let arr = req.query.convertTo.split(',');
            _.forEach(arr, (c) => {
                convertTo.push(c);
            });
        }
    }
    let arr = [];
    _.forEach(filteredList, (id) => {
        let p;
        if (exchanges[id].isDemo)
        {
            p = getDemoBalances(exchanges[id].instance);
        }
        else
        {
            p = exchanges[id].instance.getBalances();
        }
        arr.push({promise:p, context:{exchange:id,api:'getBalances'}});
    });
    let balances = {};
    PromiseHelper.all(arr).then(function(data){
        _.forEach(data, function (entry) {
            // could not retrieve balances for this exchange
            if (!entry.success)
            {
                return;
            }
            _.forEach(entry.value, (e, currency) => {
                if (undefined === balances[currency])
                {
                    balances[currency] = {volume:0,price:0,pricePercent:0,convertedPrice:{},unknownPrice:true}
                }
                balances[currency].volume += e.total;
            });
        });
        let symbols = mapExchangeCurrenciesToCoinMarketCapSymbol(Object.keys(balances));
        let opt = {symbols:symbols};
        // do we need to convert ?
        if (0 != convertTo.length)
        {
            opt.convertTo = convertTo;
        }
        // get data from coinmarketcap
        coinmarketcap.getTickers(opt).then(function(data) {
            let tickers = {};
            _.forEach(data, (entry) => {
                // ignore tickers without price
                if (null === entry.price_usd)
                {
                    return;
                }
                // ignore tickers we're not interested in
                if (undefined === balances[entry.symbol])
                {
                    entry.symbol = mapCoinMarketCapSymbolToExchangeCurrency(entry.symbol);
                    if (undefined === balances[entry.symbol])
                    {
                        return;
                    }
                }
                tickers[entry.symbol] = {'USD':entry.price_usd,'BTC':entry.price_btc};
                _.forEach(entry.converted, (e, symbol) => {
                    tickers[entry.symbol][symbol] = e.price;
                });
            });
            return sendPortfolio(res, balances, tickers);
        }).catch(function(err) {
            return Errors.sendHttpError(res, err, 'portfolio');
        });
    });
});

/**
 * When exchange is in demo mode, only generate balances for symbols in the top 20
 */
let top20TickersPromise = null;
const getTop20Tickers = () => {
    if (null === top20TickersPromise)
    {
        top20TickersPromise = new Promise((resolve, reject) => {
            coinmarketcap.getTickers({limit:20}).then((list) => {
                top20TickersPromise = null;
                return resolve(list);
            }).catch((e) => {
                logError(e, 'getTop20Tickers');
                return resolve([]);
            });
        });
    }
    return top20TickersPromise;
}
const getDemoBalances = async (exchange) => {
    let tickers = await getTop20Tickers();
    if (0 == tickers.length)
    {
        return {};
    }
    let currencies = _.map(tickers, (e) => {return e.symbol});
    return exchange.getBalances(currencies);
}

const mapExchangeCurrenciesToCoinMarketCapSymbol = (list) => {
    return _.map(list, (c) => {
        switch (c)
        {
            case 'IOTA':
                return 'MIOTA';
            case 'XRB':
                return 'NANO';
        }
        return c;
    });
}

const mapCoinMarketCapSymbolToExchangeCurrency = (symbol) => {
    // try to map currency to coinmarketcap symbol
    switch (symbol)
    {
        case 'MIOTA':
            return 'IOTA';
        case 'NANO':
            return 'XRB';
    }
    return symbol;
}

const sendPortfolio = (res, balances, tickers) => {
    let totalPriceUSD = 0;
    let totalPriceConverted = {};
    // update balances
    _.forEach(balances, (entry, currency) => {
        if (undefined === tickers[currency])
        {
            return;
        }
        entry.unknownPrice = false;
        _.forEach(tickers[currency], (p, symbol) => {
            let price;
            if ('USD' == symbol)
            {
                price = parseFloat(new Big(entry.volume).times(p).toFixed(4));
                entry.price = price;
                totalPriceUSD += price;
            }
            else
            {
                price = parseFloat(new Big(entry.volume).times(p).toFixed(8));
                entry.convertedPrice[symbol] = price;
                if (undefined === totalPriceConverted[symbol])
                {
                    totalPriceConverted[symbol] = 0;
                }
                totalPriceConverted[symbol] += price;
            }
        });
        // format volume
        entry.volume = parseFloat(entry.volume.toFixed(8));
    });
    // update %
    _.forEach(balances, (entry, currency) => {
        entry.pricePercent = parseFloat(new Big(100.0 * entry.price).div(totalPriceUSD).toFixed(2));
    });
    // update total price
    totalPriceUSD = parseFloat(totalPriceUSD.toFixed(4));
    _.forEach(Object.keys(totalPriceConverted), (symbol) => {
        totalPriceConverted[symbol] = parseFloat(totalPriceConverted[symbol].toFixed(8));
    });
    return res.send({balances:balances,price:totalPriceUSD,convertedPrice:totalPriceConverted});
}

};
