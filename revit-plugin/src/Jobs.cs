using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace ContoursToRevit
{
    /// <summary>
    /// Runs work in Revit's API context. The site window is modeless, so anything that reads or changes the
    /// model is queued here and executed when Revit raises the external event.
    /// </summary>
    internal class Jobs : IExternalEventHandler
    {
        private readonly ConcurrentQueue<(Func<UIApplication, object> work, TaskCompletionSource<object> done)> _queue = new();
        private readonly ExternalEvent _event;

        public Jobs() { _event = ExternalEvent.Create(this); }

        public Task<object> Run(Func<UIApplication, object> work)
        {
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Enqueue((work, tcs));
            var r = _event.Raise();
            if (r != ExternalEventRequest.Accepted && r != ExternalEventRequest.Pending)
                tcs.TrySetException(new InvalidOperationException("Revit is busy (" + r + "). Finish the current command and try again."));
            return tcs.Task;
        }

        public void Execute(UIApplication app)
        {
            while (_queue.TryDequeue(out var job))
            {
                try { job.done.TrySetResult(job.work(app)); }
                catch (Exception ex) { job.done.TrySetException(ex); }
            }
        }

        public string GetName() => "Contours to Revit";
    }
}
