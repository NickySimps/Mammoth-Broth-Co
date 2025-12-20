document.addEventListener('DOMContentLoaded', () => {
    const markets = [
        { name: "Atlantic Beach Farmers Market", day: 0, startHour: 10, endHour: 14, timeString: "10 AM - 2 PM" },
        { name: "Palm Valley Farmers Market", day: 2, startHour: 10, endHour: 13, timeString: "10 AM - 1 PM" },
        { name: "Murray Hill Farmers Market", day: 3, startHour: 17, endHour: 20, timeString: "5 PM - 8 PM" }
    ];

    function getNextMarket() {
        const now = new Date();
        const currentDay = now.getDay();
        const currentHour = now.getHours();

        // Create a list of upcoming market dates
        const upcoming = markets.map(market => {
            let marketDate = new Date();
            marketDate.setHours(market.endHour, 0, 0, 0); // Set to end time to check if it's passed

            // Calculate day difference
            let diff = market.day - currentDay;

            // If the day is today
            if (diff === 0) {
                // If the market has already ended today, push it to next week
                if (currentHour >= market.endHour) {
                    diff = 7;
                }
            } 
            // If the day has passed in the current week (e.g. today is Wed, market was Sun)
            else if (diff < 0) {
                diff += 7;
            }

            marketDate.setDate(now.getDate() + diff);
            return { ...market, date: marketDate };
        });

        // Sort by date to find the soonest one
        upcoming.sort((a, b) => a.date - b.date);
        return upcoming[0];
    }

    const nextMarket = getNextMarket();

    if (nextMarket) {
        // Determine label (Today, Tomorrow, or Day Name)
        const now = new Date();
        const diffDays = Math.floor((nextMarket.date.setHours(0,0,0,0) - now.setHours(0,0,0,0)) / (1000 * 60 * 60 * 24));
        
        let dayLabel = "";
        if (diffDays === 0) {
            dayLabel = "TODAY";
        } else if (diffDays === 1) {
            dayLabel = "TOMORROW";
        } else {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            dayLabel = days[nextMarket.day]; // Use the original market day index
        }

        // Create Banner
        const banner = document.createElement('div');
        banner.className = 'market-banner';
        banner.innerHTML = `
            <div class="container" style="padding: 0; text-align: center;">
                <span class="font-caveman" style="letter-spacing: 1px;">NEXT HUNT:</span>
                <strong>${dayLabel}</strong> at ${nextMarket.name} (${nextMarket.timeString})
            </div>
        `;
        
        // Insert at the very top of body
        document.body.insertBefore(banner, document.body.firstChild);
    }
});
